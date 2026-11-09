/**
 * Host half of the learning-space bundle.
 *
 * Registers one exact HTTP endpoint (`/learning-space/api`) that the Client half
 * of the bundle calls through same-origin `fetch`, a read-only health resource,
 * and a static route for the vendored KaTeX assets under `/learning-space/vendor/`.
 * Course data lives as plain files under `<home>/Documents/学习空间`:
 *
 *   <courseId>/course.json            metadata + outline + progress + generated chapter indexes
 *   <courseId>/chapters/01.md         chapter body (Markdown)
 *   <courseId>/chapters/01.quiz.json  chapter quiz
 *   <courseId>/graph.json             knowledge graph (concepts + edges)
 *
 * Model calls go through the Harness `llm` service with the profile's default
 * route, so no credential or provider code is duplicated here.
 */

import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(PACKAGE_DIR, 'vendor')
const VENDOR_PATH = '/learning-space/vendor'
const API_PATH = '/learning-space/api'
const HEALTH_PATH = '/learning-space/health'
const DATA_DIR = join(homedir(), 'Documents', '学习空间')
const MAX_BODY_BYTES = 256 * 1024
const MODEL_TIMEOUT_MS = 300 * 1000
const ID_RE = /^c-[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$/

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

const DOMAINS = {
  general: '通用通识',
  technical: '技术 / 编程',
  engineering: '工科 / 工程实践',
  humanities: '人文 / 艺术',
}

const LEVELS = {
  beginner: '入门（零基础）',
  intermediate: '进阶（有基础）',
  advanced: '深入（专业向）',
}

const DOMAIN_STYLE = {
  general: '用生活化类比和清晰结构讲通概念，避免术语堆砌，适合大众读者。',
  technical: '讲清原理与实现，可包含代码示例和流程说明，注意概念之间的依赖关系。',
  engineering: '强调真实工艺、设备、参数与安全，使用真实工程实例，禁止编程代码块。',
  humanities: '用具体作品、人物、时代与文本细读展开，避免空泛抒情和鸡汤。',
}

const JOB_TTL_MS = 30 * 60 * 1000
const JOB_TIMEOUT_MS = 10 * 60 * 1000
const MAX_JOBS = 40
const SECTION_ELEMENTS = new Set(['table', 'mermaid', 'code', 'svg', 'callout'])
const JOB_STEP_DEFS = [
  { key: 'plan', label: '规划章节结构' },
  { key: 'write', label: '分段撰写正文' },
  { key: 'concepts', label: '提取核心概念' },
  { key: 'quiz', label: '生成章末测验' },
  { key: 'validate', label: '结构与元素校验' },
  { key: 'repair', label: '定向修复' },
  { key: 'save', label: '保存文件' },
]
const chapterJobs = new Map()
const activeChapterJobs = new Map()
let jobCounter = 0

export const inject = ['webServer', 'llm', 'agentDefaultModel']

/**
 * Register the HTTP surface.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 */
export function apply(ctx) {
  void ensureDataDir()

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: HEALTH_PATH,
      resource: async () => new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: VENDOR_PATH,
      resource: async (request) => serveVendor(request),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: (req, res) => {
        handleApi(ctx, req, res).catch((error) => {
          try {
            sendJson(res, 200, { ok: false, error: publicError(error) })
          } catch {
            try {
              res.destroy()
            } catch {
              /* already closed */
            }
          }
        })
      },
    }),
  )
}

/* ------------------------------------------------------------------ */
/* Vendored static assets (KaTeX)                                      */
/* ------------------------------------------------------------------ */

async function serveVendor(request) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(`${VENDOR_PATH}/`)) return new Response('not found', { status: 404 })
  let relative
  try {
    relative = decodeURIComponent(url.pathname.slice(VENDOR_PATH.length + 1))
  } catch {
    return new Response('bad request', { status: 400 })
  }
  if (relative === '' || relative.includes('\0') || relative.includes('..') || relative.startsWith('/')) {
    return new Response('not found', { status: 404 })
  }
  const file = resolve(VENDOR_DIR, relative)
  if (!file.startsWith(resolve(VENDOR_DIR) + sep)) return new Response('not found', { status: 404 })
  let data
  try {
    const info = await stat(file)
    if (!info.isFile()) return new Response('not found', { status: 404 })
    data = await readFile(file)
  } catch {
    return new Response('not found', { status: 404 })
  }
  const type = MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  return new Response(data, {
    headers: {
      'content-type': type,
      'content-length': String(data.length),
      'cache-control': 'public, max-age=86400',
    },
  })
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

async function handleApi(ctx, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const body = await readJsonBody(req)
  const action = typeof body.action === 'string' ? body.action : ''
  let result
  switch (action) {
    case 'state':
      result = await apiState()
      break
    case 'course':
      result = await apiCourse(body.id)
      break
    case 'outline':
      result = await apiOutline(ctx, body)
      break
    case 'chapter':
      result = await apiChapter(ctx, body)
      break
    case 'job':
      result = await apiJob(body)
      break
    case 'cancel':
      result = await apiCancelJob(body)
      break
    case 'delete':
      result = await apiDelete(body.id)
      break
    case 'progress':
      result = await apiProgress(body)
      break
    case 'feedback':
      result = await apiFeedback(body)
      break
    case 'interact':
      result = await apiInteract(ctx, body)
      break
    case 'interactions':
      result = await apiInteractions(body)
      break
    case 'annotations':
      result = await apiAnnotations(body)
      break
    case 'annotate':
      result = await apiAnnotate(body)
      break
    case 'update-annotation':
      result = await apiUpdateAnnotation(body)
      break
    case 'delete-annotation':
      result = await apiDeleteAnnotation(body)
      break
    case 'assessment':
      result = await apiAssessment(ctx, body)
      break
    case 'submit-assessment':
      result = await apiSubmitAssessment(body)
      break
    case 'retrain-question':
      result = await apiRetrainQuestion(ctx, body)
      break
    case 'retrain-answer':
      result = await apiRetrainAnswer(body)
      break
    case 'plan-add':
      result = await apiPlanAdd(body)
      break
    case 'plan-update':
      result = await apiPlanUpdate(body)
      break
    case 'plan-delete':
      result = await apiPlanDelete(body)
      break
    case 'graph':
      result = await apiGraph(ctx, body, res)
      break
    case 'debug':
      result = await apiDebug(ctx)
      break
    default:
      throw httpError('BAD_REQUEST', `未知操作：${action || '(空)'}`)
  }
  sendJson(res, 200, { ok: true, ...result })
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(httpError('BAD_REQUEST', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(httpError('BAD_REQUEST', '请求体必须是 JSON 对象'))
          return
        }
        resolvePromise(parsed)
      } catch {
        reject(httpError('BAD_REQUEST', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function httpError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

function publicError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
  }
}

/* ------------------------------------------------------------------ */
/* Course storage                                                      */
/* ------------------------------------------------------------------ */

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true })
}

function courseDir(id) {
  assertId(id)
  const dir = resolve(DATA_DIR, id)
  if (dir !== resolve(DATA_DIR) && !dir.startsWith(resolve(DATA_DIR) + sep)) {
    throw httpError('BAD_REQUEST', '非法课程 id')
  }
  return dir
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw httpError('BAD_REQUEST', '非法课程 id')
}

function chapterStem(index) {
  if (!Number.isInteger(index) || index < 0 || index > 99) throw httpError('BAD_REQUEST', '非法章节序号')
  return String(index + 1).padStart(2, '0')
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

async function writeTextAtomic(path, text) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function listCourseIds() {
  try {
    const entries = await readdir(DATA_DIR, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && ID_RE.test(entry.name)).map((entry) => entry.name)
  } catch {
    return []
  }
}

function summaryOf(course) {
  const progress = course.progress !== null && typeof course.progress === 'object' ? course.progress : {}
  const review = progress.review !== null && typeof progress.review === 'object' ? progress.review : {}
  const now = Date.now()
  let reviewDue = 0
  for (const entry of Object.values(review)) {
    if (entry !== null && typeof entry === 'object' && Number.isFinite(entry.due) && entry.due <= now) reviewDue += 1
  }
  return {
    id: course.id,
    title: course.title,
    topic: course.topic,
    domain: course.domain,
    level: course.level,
    chapterCount: course.chapterCount,
    generatedCount: Array.isArray(course.generated) ? course.generated.length : 0,
    status: course.status ?? 'planned',
    doneCount: Array.isArray(progress.done) ? progress.done.length : 0,
    quizCount: progress.quiz !== null && typeof progress.quiz === 'object' ? Object.keys(progress.quiz).length : 0,
    reviewDue,
    hasGraph: course.hasGraph === true,
    unlockedCount: (() => {
      const total = Array.isArray(course.outline) ? course.outline.length : Number(course.chapterCount) || 0
      const unlocked = course.curriculum?.unlocked
      return Array.isArray(unlocked) ? unlocked.length : total
    })(),
    totalChapters: Array.isArray(course.outline) ? course.outline.length : Number(course.chapterCount) || 0,
    mastery: (() => {
      const concepts = progress.concepts
      if (concepts === null || typeof concepts !== 'object') return 0
      const values = Object.values(concepts)
        .map((entry) => (entry !== null && typeof entry === 'object' ? entry.mastery : undefined))
        .filter((value) => Number.isFinite(value))
      if (values.length === 0) return 0
      return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    })(),
    createdAt: course.createdAt ?? 0,
    updatedAt: course.updatedAt ?? 0,
    progressUpdatedAt: course.progressUpdatedAt ?? 0,
  }
}

const DEFAULT_INITIAL_UNLOCKED = 2
const DEFAULT_MASTERY_THRESHOLD = 70

function curriculumConfig(course) {
  const total = Array.isArray(course.outline) ? course.outline.length : Number(course.chapterCount) || 0
  const legacy = course.curriculum === undefined || course.curriculum === null
  const initialFallback = legacy ? total : Math.min(DEFAULT_INITIAL_UNLOCKED, total)
  const initialUnlocked = clampInt(course.curriculum?.initialUnlocked ?? initialFallback, 1, Math.max(1, total), 1)
  const masteryThreshold = clampInt(course.curriculum?.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD, 30, 100, DEFAULT_MASTERY_THRESHOLD)
  const stageSize = clampInt(course.curriculum?.stageSize ?? 3, 2, 12, 3)
  const stageThreshold = clampInt(course.curriculum?.stageThreshold ?? masteryThreshold, 30, 100, masteryThreshold)
  return { total, initialUnlocked, masteryThreshold, stageSize, stageThreshold, unlockStep: 1, legacy }
}

function chapterConceptNamesFromData(chapter, outline) {
  const fromConcepts = Array.isArray(chapter?.concepts?.concepts)
    ? chapter.concepts.concepts.map((concept) => (typeof concept?.name === 'string' ? concept.name.trim() : '')).filter(Boolean)
    : []
  if (fromConcepts.length > 0) return [...new Set(fromConcepts)]
  const outlineConcepts = Array.isArray(outline?.concepts)
    ? outline.concepts.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  return [...new Set(outlineConcepts)]
}

function quizQuestionConceptNames(question, chapterNames) {
  const bound = Array.isArray(question?.concepts)
    ? question.concepts.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
    : []
  const known = new Set(chapterNames)
  const filtered = bound.filter((name) => known.size === 0 || known.has(name))
  if (filtered.length > 0) return [...new Set(filtered)]
  if (chapterNames.length === 0) return []
  const haystack = `${question?.question ?? ''} ${Array.isArray(question?.options) ? question.options.join(' ') : ''}`
  const matched = chapterNames.filter((name) => haystack.includes(name))
  if (matched.length > 0) return matched.slice(0, 2)
  return chapterNames.slice(0, 2)
}

function mergeConceptStats(stats, chapterNames, questionList, answers, now) {
  const merged = { ...stats }
  const known = new Set(chapterNames)
  for (let questionIndex = 0; questionIndex < questionList.length; questionIndex += 1) {
    const question = questionList[questionIndex]
    if (question === null || typeof question !== 'object') continue
    const answer = Array.isArray(answers) ? answers[questionIndex] : undefined
    const correct = Number(answer) === Number(question.answerIndex)
    const boundNames = quizQuestionConceptNames(question, chapterNames)
    for (const name of boundNames) {
      const key = name.slice(0, 80)
      if (key === '') continue
      const previous =
        merged[key] ?? { attempts: 0, correct: 0, mastery: 0, updatedAt: 0, selfAssessment: null, selfAssessedAt: 0 }
      const attempts = previous.attempts + 1
      const correctCount = previous.correct + (correct ? 1 : 0)
      merged[key] = {
        attempts,
        correct: correctCount,
        mastery: attempts > 0 ? Math.round((correctCount / attempts) * 100) : 0,
        updatedAt: now,
        selfAssessment: previous.selfAssessment ?? null,
        selfAssessedAt: previous.selfAssessedAt ?? 0,
      }
    }
  }
  return merged
}

function sanitizeConceptStats(stats) {
  const cleaned = {}
  for (const [name, value] of Object.entries(stats ?? {})) {
    const key = typeof name === 'string' ? name.trim().slice(0, 80) : ''
    if (key === '' || value === null || typeof value !== 'object') continue
    const attempts = clampInt(value.attempts, 0, 999, 0)
    const assessment =
      typeof value.selfAssessment === 'string' && ['understood', 'unsure', 'lost'].includes(value.selfAssessment)
        ? value.selfAssessment
        : null
    if (attempts === 0 && assessment === null) continue
    const correct = clampInt(value.correct, 0, attempts, 0)
    cleaned[key] = {
      attempts,
      correct,
      mastery: clampInt(value.mastery, 0, 100, attempts > 0 ? Math.round((correct / attempts) * 100) : 0),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      selfAssessment: assessment,
      selfAssessedAt: Number.isFinite(value.selfAssessedAt) ? value.selfAssessedAt : 0,
    }
  }
  return cleaned
}

function effectiveConceptMastery(entry) {
  if (entry === null || entry === undefined) return null
  const base = entry.attempts > 0 ? entry.mastery : null
  const cap = entry.selfAssessment === 'lost' ? 30 : entry.selfAssessment === 'unsure' ? 60 : 100
  if (base === null) {
    if (entry.selfAssessment === 'lost') return 0
    if (entry.selfAssessment === 'unsure') return 40
    return null
  }
  return Math.min(base, cap)
}

function stageAssessmentState(progress, stageIndex, threshold) {
  const entry = progress.assessments?.[stageIndex]
  if (entry === undefined || entry === null) return null
  const percent = entry.total > 0 ? Math.round((entry.score / entry.total) * 100) : 0
  return {
    score: entry.score,
    total: entry.total,
    answers: Array.isArray(entry.answers) ? entry.answers : [],
    at: entry.at ?? 0,
    percent,
    passed: percent >= threshold,
  }
}

function evaluateCurriculumFromLoaded(course, chapters, progress) {
  const config = curriculumConfig(course)
  const total = config.total
  const unlocked = new Set()
  const initialCount = config.legacy ? total : Math.min(config.initialUnlocked, total)
  for (let index = 0; index < initialCount; index += 1) unlocked.add(index)
  const chapterMastery = []
  for (let index = 0; index < total; index += 1) {
    const names = chapterConceptNamesFromData(chapters[index], course.outline?.[index])
    const values = names
      .map((name) => effectiveConceptMastery(progress.concepts?.[name]))
      .filter((value) => Number.isFinite(value))
    const mastery = values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0
    const quizEntry = progress.quiz?.[index]
    const quizScore = quizEntry !== undefined && quizEntry.total > 0 ? Math.round((quizEntry.score / quizEntry.total) * 100) : null
    const done = Array.isArray(progress.done) && progress.done.includes(index)
    chapterMastery.push({ index, title: course.outline?.[index]?.title ?? `第 ${index + 1} 章`, mastery, quizScore, done, conceptCount: names.length, generated: Boolean(chapters[index]) })
  }
  if (!config.legacy) {
    for (let index = config.initialUnlocked; index < total; index += 1) {
      const previous = chapterMastery[index - 1]
      const quizOkay = previous.quizScore !== null && previous.quizScore >= config.masteryThreshold
      const masteryOkay = previous.conceptCount === 0 || previous.mastery >= config.masteryThreshold
      if (!previous.done || !quizOkay || !masteryOkay) break
      if (index > 0 && index % config.stageSize === 0) {
        const stageResult = stageAssessmentState(progress, index / config.stageSize - 1, config.stageThreshold)
        if (stageResult === null || !stageResult.passed) break
      }
      unlocked.add(index)
    }
  }
  const unlockedIndexes = [...unlocked].sort((a, b) => a - b)
  const nextLocked = [...Array(total).keys()].find((index) => !unlocked.has(index))
  let nextUnlock = null
  if (nextLocked !== undefined) {
    const previous = chapterMastery[nextLocked - 1]
    const requirements = []
    if (!config.legacy && nextLocked > 0 && nextLocked % config.stageSize === 0) {
      const stageIndex = nextLocked / config.stageSize - 1
      const stageResult = stageAssessmentState(progress, stageIndex, config.stageThreshold)
      requirements.push({
        key: 'assessment',
        label: `阶段 ${stageIndex + 1} 测评 ≥ ${config.stageThreshold}%`,
        met: stageResult !== null && stageResult.passed,
        detail: stageResult === null ? '未测评' : `当前 ${stageResult.percent}%`,
      })
    }
    if (previous !== undefined) {
      requirements.push({ key: 'done', label: '完成上一章学习', met: previous.done, detail: previous.done ? '已完成' : '未完成' })
      requirements.push({
        key: 'quiz',
        label: `上一章测验 ≥ ${config.masteryThreshold}%`,
        met: previous.quizScore !== null && previous.quizScore >= config.masteryThreshold,
        detail: previous.quizScore === null ? '未测验' : `当前 ${previous.quizScore}%`,
      })
      requirements.push({
        key: 'mastery',
        label: `上一章概念掌握 ≥ ${config.masteryThreshold}%`,
        met: previous.conceptCount === 0 || previous.mastery >= config.masteryThreshold,
        detail: previous.conceptCount === 0 ? '暂无概念数据' : `当前 ${previous.mastery}%`,
      })
    }
    nextUnlock = { index: nextLocked, chapterTitle: course.outline?.[nextLocked]?.title ?? `第 ${nextLocked + 1} 章`, requirements, ready: requirements.length > 0 && requirements.every((item) => item.met) }
  }
  const stages = []
  for (let start = 0; start < total; start += config.stageSize) {
    const end = Math.min(total, start + config.stageSize) - 1
    const stageIndex = start / config.stageSize
    const chapterIndexes = []
    for (let index = start; index <= end; index += 1) chapterIndexes.push(index)
    const available = chapterIndexes.every((index) => unlocked.has(index))
    const result = stageAssessmentState(progress, stageIndex, config.stageThreshold)
    stages.push({
      index: stageIndex,
      title: `阶段 ${stageIndex + 1}`,
      startChapterIndex: start,
      endChapterIndex: end,
      chapterIndexes,
      chapterTitles: chapterIndexes.map((index) => course.outline?.[index]?.title ?? `第 ${index + 1} 章`),
      available,
      result: result === null ? null : { score: result.score, total: result.total, percent: result.percent, at: result.at, passed: result.passed },
      threshold: config.stageThreshold,
    })
  }
  return {
    total,
    initialUnlocked: config.initialUnlocked,
    masteryThreshold: config.masteryThreshold,
    stageSize: config.stageSize,
    stageThreshold: config.stageThreshold,
    legacy: config.legacy,
    unlocked: unlockedIndexes,
    locked: [...Array(total).keys()].filter((index) => !unlocked.has(index)),
    nextUnlock,
    chapters: chapterMastery,
    stages,
  }
}

function computeMasteryFromLoaded(course, chapters, progress, curriculum) {
  const perChapter = (curriculum?.chapters ?? []).map((chapter) => {
    const names = chapterConceptNamesFromData(chapters[chapter.index], course.outline?.[chapter.index])
    const conceptItems = names.map((name) => {
      const entry = progress.concepts?.[name]
      const effective = effectiveConceptMastery(entry)
      return {
        name,
        mastery: effective === null ? 0 : effective,
        attempts: entry === undefined ? 0 : entry.attempts,
        correct: entry === undefined ? 0 : entry.correct,
        selfAssessment: entry === undefined || entry === null ? null : entry.selfAssessment ?? null,
      }
    })
    return {
      index: chapter.index,
      title: chapter.title,
      unlocked: Array.isArray(curriculum?.unlocked) && curriculum.unlocked.includes(chapter.index),
      done: chapter.done,
      generated: chapter.generated,
      quizScore: chapter.quizScore,
      mastery: chapter.mastery,
      concepts: conceptItems,
    }
  })
  const all = perChapter.flatMap((chapter) => chapter.concepts.map((concept) => ({ ...concept, chapterIndex: chapter.index, chapterTitle: chapter.title })))
  const scored = all.filter((concept) => concept.attempts > 0 || concept.selfAssessment !== null && concept.selfAssessment !== undefined)
  const overall = scored.length > 0 ? Math.round(scored.reduce((sum, concept) => sum + concept.mastery, 0) / scored.length) : 0
  const weakest = scored.slice().sort((a, b) => a.mastery - b.mastery).slice(0, 5)
  return { overall, chapters: perChapter, weakest }
}

function deriveWrongBook(course, chapters, progress) {
  const items = []
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex]
    if (chapter === null || !Array.isArray(chapter.quiz?.questions)) continue
    const entry = progress.quiz?.[chapterIndex]
    if (entry === undefined) continue
    const answers = Array.isArray(entry.answers) ? entry.answers : []
    for (let questionIndex = 0; questionIndex < chapter.quiz.questions.length; questionIndex += 1) {
      const question = chapter.quiz.questions[questionIndex]
      if (question === null || typeof question !== 'object') continue
      const chosen = Number(answers[questionIndex])
      if (!Number.isInteger(chosen) || chosen === Number(question.answerIndex)) continue
      const retrainEntry = progress.retrain?.[`${chapterIndex}:${questionIndex}`]
      items.push({
        chapterIndex,
        chapterTitle: course.outline?.[chapterIndex]?.title ?? `第 ${chapterIndex + 1} 章`,
        questionIndex,
        question: question.question,
        options: Array.isArray(question.options) ? question.options : [],
        answerIndex: question.answerIndex,
        chosen,
        explanation: typeof question.explanation === 'string' ? question.explanation : '',
        concepts: Array.isArray(question.concepts) ? question.concepts : [],
        at: entry.at ?? 0,
        resolved: retrainEntry !== undefined && retrainEntry.resolved === true,
        retrain:
          retrainEntry === undefined
            ? null
            : { attempts: retrainEntry.attempts, correct: retrainEntry.correct, resolved: retrainEntry.resolved, lastAt: retrainEntry.lastAt },
      })
      if (items.length >= 100) return items
    }
  }
  return items.sort((a, b) => (a.resolved === b.resolved ? b.at - a.at : a.resolved ? 1 : -1))
}

function deriveDoubts(progress) {
  const doubts = []
  for (const [name, entry] of Object.entries(progress.concepts ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.selfAssessment !== 'lost' && entry.selfAssessment !== 'unsure') continue
    doubts.push({ name, selfAssessment: entry.selfAssessment, mastery: effectiveConceptMastery(entry), attempts: entry.attempts, updatedAt: entry.selfAssessedAt || entry.updatedAt || 0 })
  }
  return doubts.sort((a, b) => b.updatedAt - a.updatedAt)
}

function deriveLearningPlan(course, curriculum, mastery, progress, wrongBook) {
  const items = []
  const now = Date.now()
  if (curriculum.nextUnlock !== null) {
    for (const requirement of curriculum.nextUnlock.requirements) {
      if (requirement.met) continue
      items.push({
        type: 'unlock',
        title: `解锁「${curriculum.nextUnlock.chapterTitle}」`,
        detail: `${requirement.label}${requirement.detail ? ` · ${requirement.detail}` : ''}`,
        chapterIndex: Math.max(0, curriculum.nextUnlock.index - 1),
      })
    }
  }
  for (const [key, entry] of Object.entries(progress.review ?? {})) {
    const index = Number(key)
    if (!Number.isInteger(index) || entry === null || typeof entry !== 'object') continue
    if (Number(entry.due) > now) continue
    items.push({
      type: 'review',
      title: `复习第 ${index + 1} 章`,
      detail: '已到复习时间',
      chapterIndex: index,
    })
  }
  for (const concept of (mastery.weakest ?? []).filter((item) => item.mastery < 60).slice(0, 3)) {
    items.push({
      type: 'mastery',
      title: `补强「${concept.name}」`,
      detail: `掌握度 ${concept.mastery}%`,
      chapterIndex: concept.chapterIndex,
      conceptName: concept.name,
    })
  }
  const unresolvedWrong = (Array.isArray(wrongBook) ? wrongBook : []).filter((item) => item !== null && item !== undefined && item.resolved !== true)
  if (unresolvedWrong.length > 0) {
    items.push({
      type: 'retrain',
      title: `订正 ${unresolvedWrong.length} 道错题`,
      detail: '到错题本重做或做变式题',
      chapterIndex: unresolvedWrong[0].chapterIndex,
    })
  }
  for (const chapter of curriculum.chapters) {
    if (chapter.unlocked && !chapter.generated) {
      items.push({
        type: 'generate',
        title: `生成第 ${chapter.index + 1} 章`,
        detail: '已解锁，等待生成',
        chapterIndex: chapter.index,
      })
    }
  }
  const seen = new Set()
  return items
    .filter((item) => {
      const key = `${item.type}:${item.title}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 8)
}

function deriveCertificate(course, curriculum, mastery, progress, doubts) {
  const total = curriculum.total
  const doneCount = Array.isArray(progress.done) ? progress.done.length : 0
  const allGenerated = curriculum.chapters.every((chapter) => chapter.generated)
  const noLocked = curriculum.locked.length === 0
  const lostCount = doubts.filter((item) => item.selfAssessment === 'lost').length
  const eligible = noLocked && allGenerated && doneCount >= total && mastery.overall >= curriculum.masteryThreshold && lostCount === 0
  return {
    eligible,
    overall: mastery.overall,
    threshold: curriculum.masteryThreshold,
    completedChapters: doneCount,
    totalChapters: total,
    allGenerated,
    lostDoubts: lostCount,
  }
}

function normalizeStudyPlan(raw) {
  const list = Array.isArray(raw) ? raw : []
  const items = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 200) : ''
    if (title === '') continue
    const dueAt = Number(item.dueAt)
    const status = item.status === 'done' ? 'done' : 'pending'
    const chapterIndex = Number(item.chapterIndex)
    items.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `pl-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
      title,
      detail: typeof item.detail === 'string' ? item.detail.trim().slice(0, 500) : '',
      dueAt: Number.isFinite(dueAt) ? dueAt : 0,
      status,
      chapterIndex: Number.isInteger(chapterIndex) && chapterIndex >= 0 ? chapterIndex : null,
      conceptName: typeof item.conceptName === 'string' ? item.conceptName.trim().slice(0, 80) : '',
      source: item.source === 'suggestion' ? 'suggestion' : 'manual',
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
      completedAt: Number.isFinite(item.completedAt) ? item.completedAt : 0,
    })
    if (items.length >= 200) break
  }
  return items
}

async function loadCourse(id) {
  const dir = courseDir(id)
  const course = await readJsonFile(join(dir, 'course.json'), null)
  if (course === null) throw httpError('NOT_FOUND', '课程不存在')
  const outline = Array.isArray(course.outline) ? course.outline : []
  const generated = new Set(Array.isArray(course.generated) ? course.generated : [])
  const chapters = []
  for (let index = 0; index < outline.length; index += 1) {
    if (!generated.has(index)) {
      chapters.push(null)
      continue
    }
    const stem = chapterStem(index)
    let markdown = ''
    try {
      markdown = await readFile(join(dir, 'chapters', `${stem}.md`), 'utf8')
    } catch {
      chapters.push(null)
      continue
    }
    const quiz = await readJsonFile(join(dir, 'chapters', `${stem}.quiz.json`), null)
    const concepts = await readJsonFile(join(dir, 'chapters', `${stem}.concepts.json`), null)
    chapters.push({
      index,
      number: index + 1,
      title: outline[index]?.title ?? `第 ${index + 1} 章`,
      markdown,
      quiz,
      concepts,
    })
  }
  const graph = await readJsonFile(join(dir, 'graph.json'), null)
  const progress = normalizeProgress(course.progress)
  const curriculum = evaluateCurriculumFromLoaded(course, chapters, progress)
  const mastery = computeMasteryFromLoaded(course, chapters, progress, curriculum)
  for (const chapter of chapters) {
    if (chapter !== null) chapter.unlocked = curriculum.unlocked.includes(chapter.index)
  }
  const doubts = deriveDoubts(progress)
  const wrongBook = deriveWrongBook(course, chapters, progress)
  const certificate = deriveCertificate(course, curriculum, mastery, progress, doubts)
  const plan = deriveLearningPlan(course, curriculum, mastery, progress, wrongBook)
  return {
    id: course.id,
    title: course.title,
    topic: course.topic,
    domain: course.domain,
    level: course.level,
    chapterCount: course.chapterCount,
    status: course.status ?? 'planned',
    createdAt: course.createdAt ?? 0,
    updatedAt: course.updatedAt ?? 0,
    progressUpdatedAt: course.progressUpdatedAt ?? 0,
    model: course.model ?? null,
    outline,
    chapters,
    progress,
    curriculum,
    mastery,
    doubts,
    wrongBook,
    certificate,
    plan,
    studyPlan: normalizeStudyPlan(course.studyPlan),
    graph,
  }
}

/* ------------------------------------------------------------------ */
/* API actions                                                         */
/* ------------------------------------------------------------------ */

async function apiState() {
  await ensureDataDir()
  const ids = await listCourseIds()
  const courses = []
  for (const id of ids) {
    const course = await readJsonFile(join(DATA_DIR, id, 'course.json'), null)
    if (course !== null) courses.push(summaryOf(course))
  }
  courses.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return { dataDir: DATA_DIR, courses }
}

async function apiCourse(id) {
  return { course: await loadCourse(id) }
}

async function apiDelete(id) {
  const dir = courseDir(id)
  const exists = await stat(dir).then(() => true).catch(() => false)
  if (!exists) throw httpError('NOT_FOUND', '课程不存在')
  await rm(dir, { recursive: true, force: true })
  return {}
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function progressIndexKey(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number < 100 ? number : null
}

function normalizeProgress(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const done = Array.isArray(source.done)
    ? [...new Set(source.done.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < 100))].sort(
        (a, b) => a - b,
      )
    : []
  const quiz = {}
  if (source.quiz !== null && typeof source.quiz === 'object' && !Array.isArray(source.quiz)) {
    for (const [key, value] of Object.entries(source.quiz)) {
      const index = progressIndexKey(key)
      if (index === null || value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const score = Number(value.score)
      const total = Number(value.total)
      if (!Number.isFinite(score) || !Number.isFinite(total)) continue
      quiz[index] = {
        score: clampInt(score, 0, 999, 0),
        total: clampInt(total, 1, 999, 1),
        answers: Array.isArray(value.answers)
          ? value.answers.map(Number).filter((answer) => Number.isInteger(answer)).slice(0, 20)
          : [],
        at: Number.isFinite(value.at) ? value.at : 0,
      }
    }
  }
  const review = {}
  if (source.review !== null && typeof source.review === 'object' && !Array.isArray(source.review)) {
    for (const [key, value] of Object.entries(source.review)) {
      const index = progressIndexKey(key)
      if (index === null || value === null || typeof value !== 'object' || Array.isArray(value)) continue
      review[index] = {
        due: Number.isFinite(value.due) ? value.due : 0,
        intervalDays: clampInt(value.intervalDays, 1, 365, 1),
        reps: clampInt(value.reps, 0, 999, 0),
        lastScore: clampInt(value.lastScore, 0, 100, 0),
        lastAt: Number.isFinite(value.lastAt) ? value.lastAt : 0,
      }
    }
  }
  const assessments = {}
  if (source.assessments !== null && typeof source.assessments === 'object' && !Array.isArray(source.assessments)) {
    for (const [key, value] of Object.entries(source.assessments)) {
      const index = progressIndexKey(key)
      if (index === null || value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const score = Number(value.score)
      const total = Number(value.total)
      if (!Number.isFinite(score) || !Number.isFinite(total) || total <= 0) continue
      assessments[index] = {
        score: clampInt(score, 0, 999, 0),
        total: clampInt(total, 1, 999, 1),
        answers: Array.isArray(value.answers)
          ? value.answers.map(Number).filter((answer) => Number.isInteger(answer)).slice(0, 30)
          : [],
        at: Number.isFinite(value.at) ? value.at : 0,
        passed: value.passed === true,
      }
    }
  }
  const retrain = {}
  if (source.retrain !== null && typeof source.retrain === 'object' && !Array.isArray(source.retrain)) {
    for (const [key, value] of Object.entries(source.retrain)) {
      const match = /^(\d+):(\d+)$/.exec(String(key))
      if (match === null || value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const chapterIndex = Number(match[1])
      const questionIndex = Number(match[2])
      if (!Number.isInteger(chapterIndex) || !Number.isInteger(questionIndex)) continue
      retrain[`${chapterIndex}:${questionIndex}`] = {
        attempts: clampInt(value.attempts, 0, 999, 0),
        correct: clampInt(value.correct, 0, 999, 0),
        resolved: value.resolved === true,
        lastAt: Number.isFinite(value.lastAt) ? value.lastAt : 0,
      }
    }
  }
  const concepts = {}
  if (source.concepts !== null && typeof source.concepts === 'object' && !Array.isArray(source.concepts)) {
    for (const [name, value] of Object.entries(source.concepts)) {
      const key = typeof name === 'string' ? name.trim().slice(0, 80) : ''
      if (key === '' || value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const attempts = clampInt(value.attempts, 0, 999, 0)
      const assessment =
        typeof value.selfAssessment === 'string' && ['understood', 'unsure', 'lost'].includes(value.selfAssessment)
          ? value.selfAssessment
          : null
      if (attempts === 0 && assessment === null) continue
      const correct = clampInt(value.correct, 0, attempts, 0)
      concepts[key] = {
        attempts,
        correct,
        mastery: clampInt(value.mastery, 0, 100, attempts > 0 ? Math.round((correct / attempts) * 100) : 0),
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
        selfAssessment: assessment,
        selfAssessedAt: Number.isFinite(value.selfAssessedAt) ? value.selfAssessedAt : 0,
      }
    }
  }
  return {
    done,
    quiz,
    review,
    assessments,
    retrain,
    concepts,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  }
}

async function apiProgress(body) {
  const id = body.id
  assertId(id)
  const dir = courseDir(id)
  const stored = await readJsonFile(join(dir, 'course.json'), null)
  if (stored === null) throw httpError('NOT_FOUND', '课程不存在')
  const incoming = normalizeProgress(body.progress)
  const previous = normalizeProgress(stored.progress)
  const course = await loadCourse(id)
  const conceptStats = { ...previous.concepts }
  const chapterDir = join(dir, 'chapters')
  for (const [key, entry] of Object.entries(incoming.quiz)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= course.outline.length) continue
    const prior = previous.quiz[index]
    if (prior !== undefined && Number(entry.at) <= Number(prior.at)) continue
    const stem = chapterStem(index)
    const quiz = await readJsonFile(join(chapterDir, `${stem}.quiz.json`), null)
    if (quiz === null || !Array.isArray(quiz.questions)) continue
    const conceptNames = chapterConceptNamesFromData(course.chapters[index], course.outline[index])
    const merged = mergeConceptStats(conceptStats, conceptNames, quiz.questions, entry.answers, Date.now())
    for (const [name, value] of Object.entries(merged)) conceptStats[name] = value
  }
  const progress = normalizeProgress({
    ...incoming,
    assessments: previous.assessments,
    retrain: previous.retrain,
    concepts: sanitizeConceptStats(conceptStats),
    updatedAt: Date.now(),
  })
  stored.progress = progress
  stored.progressUpdatedAt = progress.updatedAt
  await writeJsonAtomic(join(dir, 'course.json'), stored)

  const updated = await loadCourse(id)
  const curriculum = updated.curriculum
  const mastery = updated.mastery
  const previousUnlocked = new Set(
    Array.isArray(stored.curriculum?.unlocked) ? stored.curriculum.unlocked : [],
  )
  const newlyUnlocked = curriculum.unlocked.filter((index) => !previousUnlocked.has(index))
  stored.curriculum = {
    ...(stored.curriculum ?? {}),
    initialUnlocked: curriculum.initialUnlocked,
    masteryThreshold: curriculum.masteryThreshold,
    stageSize: curriculum.stageSize,
    stageThreshold: curriculum.stageThreshold,
    unlockStep: 1,
    unlocked: curriculum.unlocked,
  }
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  try {
    await rebuildGraphForCourse(id)
  } catch (error) {
    /* graph refresh is best-effort */
  }
  return { progress, curriculum, mastery, newlyUnlocked }
}

/* ------------------------------------------------------------------ */
/* Concept feedback + selection interactions                           */
/* ------------------------------------------------------------------ */

const FEEDBACK_LEVELS = new Set(['understood', 'unsure', 'lost'])
const INTERACTION_KINDS = new Set(['explain', 'compare', 'figure'])

async function readInteractions(dir) {
  const items = await readJsonFile(join(dir, 'interactions.json'), [])
  return Array.isArray(items) ? items : []
}

async function apiFeedback(body) {
  const id = body.id
  assertId(id)
  const chapterIndex = Number(body.chapterIndex)
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw httpError('BAD_REQUEST', '非法章节序号')
  const conceptName = typeof body.conceptName === 'string' ? body.conceptName.trim().slice(0, 80) : ''
  if (conceptName === '') throw httpError('BAD_REQUEST', '缺少概念名称')
  const assessment = typeof body.assessment === 'string' ? body.assessment : ''
  if (!FEEDBACK_LEVELS.has(assessment)) throw httpError('BAD_REQUEST', '非法掌握度反馈')
  const dir = courseDir(id)
  const stored = await readJsonFile(join(dir, 'course.json'), null)
  if (stored === null) throw httpError('NOT_FOUND', '课程不存在')
  const progress = normalizeProgress(stored.progress)
  const previous = progress.concepts[conceptName] ?? {
    attempts: 0,
    correct: 0,
    mastery: 0,
    updatedAt: 0,
    selfAssessment: null,
    selfAssessedAt: 0,
  }
  progress.concepts[conceptName] = {
    ...previous,
    selfAssessment: assessment,
    selfAssessedAt: Date.now(),
    updatedAt: Date.now(),
  }
  progress.updatedAt = Date.now()
  stored.progress = progress
  stored.progressUpdatedAt = progress.updatedAt
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  const updated = await loadCourse(id)
  stored.curriculum = {
    ...(stored.curriculum ?? {}),
    initialUnlocked: updated.curriculum.initialUnlocked,
    masteryThreshold: updated.curriculum.masteryThreshold,
    unlockStep: 1,
    unlocked: updated.curriculum.unlocked,
  }
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  return { progress: updated.progress, curriculum: updated.curriculum, mastery: updated.mastery, doubts: updated.doubts }
}

function interactionContext(markdown, selection) {
  const text = String(markdown ?? '')
  const at = selection === '' ? -1 : text.indexOf(selection)
  if (at < 0) return text.slice(0, 3500)
  return text.slice(Math.max(0, at - 700), Math.min(text.length, at + selection.length + 900))
}

async function apiInteract(ctx, body) {
  const id = body.id
  assertId(id)
  const chapterIndex = Number(body.chapterIndex)
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw httpError('BAD_REQUEST', '非法章节序号')
  const kind = typeof body.kind === 'string' ? body.kind : ''
  if (!INTERACTION_KINDS.has(kind)) throw httpError('BAD_REQUEST', '不支持的互动类型')
  const selection = typeof body.selection === 'string' ? body.selection.trim().slice(0, 3000) : ''
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 1000) : ''
  if (kind !== 'figure' && selection === '' && question === '') throw httpError('BAD_REQUEST', '请先选中一段文本或提出问题')
  const course = await loadCourse(id)
  const outline = course.outline[chapterIndex]
  const chapter = course.chapters[chapterIndex]
  if (outline === undefined) throw httpError('NOT_FOUND', '章节不存在')
  if (chapter === null || typeof chapter.markdown !== 'string') throw httpError('BAD_REQUEST', '本章尚未生成，无法互动')
  const chapterConceptNames = chapterConceptNamesFromData(chapter, outline)
  const courseConceptNames = []
  for (let chapterIdx = 0; chapterIdx < course.outline.length; chapterIdx += 1) {
    const names = chapterConceptNamesFromData(course.chapters[chapterIdx], course.outline[chapterIdx])
    for (const name of names) {
      if (!courseConceptNames.includes(name)) courseConceptNames.push(name)
    }
  }
  let conceptName = typeof body.conceptName === 'string' ? body.conceptName.trim().slice(0, 80) : ''
  if (conceptName === '' && selection !== '') {
    const matched = [...courseConceptNames, ...chapterConceptNames]
      .filter((name) => selection.includes(name) || (selection.length >= 2 && name.includes(selection)))
      .sort((a, b) => b.length - a.length)[0]
    if (matched !== undefined) conceptName = matched
  }
  const context = interactionContext(chapter.markdown, selection)
  let related = []
  if (conceptName !== '') {
    const graph = await readJsonFile(join(courseDir(id), 'graph.json'), null)
    if (graph !== null && Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
      const node = graph.nodes.find((item) => item !== null && typeof item === 'object' && item.label === conceptName)
      if (node !== undefined) {
        const neighborIds = new Set()
        for (const edge of graph.edges) {
          if (edge === null || typeof edge !== 'object') continue
          if (edge.source === node.id) neighborIds.add(edge.target)
          else if (edge.target === node.id) neighborIds.add(edge.source)
        }
        related = graph.nodes.filter((item) => neighborIds.has(item.id)).map((item) => item.label).slice(0, 6)
      }
    }
    if (related.length === 0) related = conceptNames.filter((name) => name !== conceptName).slice(0, 4)
  }
  let answer = ''
  let svg = null
  if (kind === 'figure') {
    const system =
      '你是一位擅长用纯内联 SVG 绘制示意图的工程与科普插画师。只输出一个完整的 <svg>...</svg> 片段，不要解释、不要 Markdown 代码围栏、不要其它文字。'
    const prompt = [
      `课程：《${course.title}》（${DOMAINS[course.domain] ?? '通用通识'}，${LEVELS[course.level] ?? '入门'}）`,
      `章节：《${outline.title}》`,
      conceptName === '' ? '' : `需要可视化的概念：${conceptName}`,
      selection === '' ? '' : `用户选中的原文：${selection}`,
      question === '' ? '' : `用户的额外要求：${question}`,
      '',
      '请画一张帮助理解该概念/片段的示意图：',
      course.domain === 'humanities'
        ? '画面要求：作品场景 / 空间布局 / 时间线或人物关系，带中文标注。'
        : '画面要求：结构剖面 / 工艺流程 / 管线与流向 / 关系布局，带中文标注与箭头。',
      '规范：只输出 <svg viewBox="0 0 680 400" xmlns="http://www.w3.org/2000/svg">…</svg>；全部样式内联（禁止 <style>/class/CSS 变量/外部字体或图片）；浅底 #ffffff/#f8fafc、文字 #1f2937；线宽 1.5-2、字号 11-15px；所有文字落在画布内且不重叠。',
    ]
      .filter((line) => line !== '')
      .join('\n')
    const raw = await callModel(ctx, { system, prompt, maxTokens: 4500 })
    const fragment = extractSvgFragment(raw)
    if (fragment === null || !isSafeSvgFragment(fragment)) throw httpError('PARSE_FAILED', '没有画出可用的示意图，请重试')
    svg = fragment
  } else {
    const system =
      kind === 'compare'
        ? '你是一位擅长辨析易混概念的学习助教。只输出 Markdown，不要输出 JSON。'
        : '你是一位耐心的学习助教。只输出 Markdown，不要输出 JSON。'
    const compareTarget =
      conceptName !== ''
        ? conceptName
        : selection.length <= 40
          ? selection
          : '选中文本中最需要辨析的一个概念/参数'
    const prompt = [
      `课程：《${course.title}》`,
      `章节：《${outline.title}》`,
      conceptName === '' ? '' : `涉及概念：${conceptName}`,
      related.length > 0 ? `相关概念：${related.join('、')}` : '',
      selection === '' ? '' : `用户选中的原文：\n${selection}`,
      question === '' ? '' : `用户的追问：${question}`,
      '',
      '章节上下文：',
      context,
      '',
      kind === 'compare'
        ? [
            `本次辨析对象必须严格来自用户选中的文本（${compareTarget}），不要换成无关概念。`,
            `请围绕「${compareTarget}」做概念辨析：用一张 Markdown 对比表格（维度 >= 3，第一列是对比维度，后面是目标对象与最容易被混淆的 1-2 个相邻概念/参数），再加一段「一句话区别」和一个常见误区。`,
            courseConceptNames.length > 0
              ? `课程概念列表（只可作为对比对象，禁止把辨析对象换成其中一个）：${courseConceptNames.slice(0, 40).join('、')}`
              : '',
            '总长不超过 600 字。',
          ].filter((line) => line !== '')
        : '请解释这段内容：先用一句话给结论，再拆成 2-4 个要点，配一个生活化类比或具体例子，指出一个常见误区。总长不超过 600 字。',
      '要求：结合本章上下文，不要复述原文，不要出测验题。',
    ]
      .filter((line) => line !== '')
      .join('\n')
    answer = (await callModel(ctx, { system, prompt, maxTokens: 2800 })).trim()
    if (answer === '') throw httpError('PARSE_FAILED', '模型没有返回内容，请重试')
  }
  const dir = courseDir(id)
  const item = {
    id: `it-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
    courseId: id,
    chapterIndex,
    kind,
    selection,
    conceptName,
    question,
    answer,
    svg,
    createdAt: Date.now(),
  }
  const items = await readInteractions(dir)
  items.unshift(item)
  await writeJsonAtomic(join(dir, 'interactions.json'), items.slice(0, 200))
  return { interaction: item }
}

async function apiInteractions(body) {
  const id = body.id
  assertId(id)
  const chapterIndex = body.chapterIndex === undefined ? null : Number(body.chapterIndex)
  const items = await readInteractions(courseDir(id))
  const filtered = chapterIndex === null || !Number.isInteger(chapterIndex)
    ? items
    : items.filter((item) => item !== null && typeof item === 'object' && item.chapterIndex === chapterIndex)
  return { items: filtered.slice(0, 50) }
}

/* ------------------------------------------------------------------ */
/* Reading annotations (highlight / underline / note)                  */
/* ------------------------------------------------------------------ */

const ANNOTATION_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple'])
const ANNOTATION_STYLES = new Set(['highlight', 'underline'])

async function readAnnotations(dir) {
  const items = await readJsonFile(join(dir, 'annotations.json'), [])
  return Array.isArray(items) ? items.map((item) => ensureAnnotationNotes(item)) : []
}

function normalizeAnnotationStyle(style) {
  return ANNOTATION_STYLES.has(style) ? style : 'highlight'
}

function normalizeAnnotationColor(color) {
  return ANNOTATION_COLORS.has(color) ? color : 'yellow'
}

function ensureAnnotationNotes(annotation) {
  if (annotation === null || typeof annotation !== 'object') return annotation
  const notes = []
  if (Array.isArray(annotation.notes)) {
    for (let index = 0; index < annotation.notes.length; index += 1) {
      const item = annotation.notes[index]
      if (item === null || typeof item !== 'object') continue
      const text = typeof item.text === 'string' ? item.text.trim().slice(0, 2000) : ''
      if (text === '') continue
      notes.push({
        id: typeof item.id === 'string' && item.id !== '' ? item.id : `nt-${annotation.id ?? 'legacy'}-${index + 1}`,
        text,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Number.isFinite(annotation.createdAt) ? annotation.createdAt : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      })
    }
  }
  if (notes.length === 0 && typeof annotation.note === 'string' && annotation.note.trim() !== '') {
    notes.push({
      id: `nt-${annotation.id ?? 'legacy'}-1`,
      text: annotation.note.trim().slice(0, 2000),
      createdAt: Number.isFinite(annotation.createdAt) ? annotation.createdAt : Date.now(),
      updatedAt: Number.isFinite(annotation.updatedAt) ? annotation.updatedAt : 0,
    })
  }
  annotation.notes = notes
  annotation.note = notes.length > 0 ? notes[notes.length - 1].text : ''
  return annotation
}

async function apiAnnotations(body) {
  const id = body.id
  assertId(id)
  const chapterIndex = body.chapterIndex === undefined ? null : Number(body.chapterIndex)
  const items = await readAnnotations(courseDir(id))
  const filtered =
    chapterIndex === null || !Number.isInteger(chapterIndex)
      ? items
      : items.filter((item) => item !== null && typeof item === 'object' && item.chapterIndex === chapterIndex)
  return { items: filtered.slice(0, 500) }
}

async function apiAnnotate(body) {
  const id = body.id
  assertId(id)
  const chapterIndex = Number(body.chapterIndex)
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw httpError('BAD_REQUEST', '非法章节序号')
  const quote = typeof body.quote === 'string' ? body.quote.trim().slice(0, 3000) : ''
  if (quote === '') throw httpError('BAD_REQUEST', '标注内容不能为空')
  const course = await loadCourse(id)
  if (course.outline[chapterIndex] === undefined) throw httpError('NOT_FOUND', '章节不存在')
  const dir = courseDir(id)
  const items = await readAnnotations(dir)
  const now = Date.now()
  const noteText = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : ''
  const annotation = ensureAnnotationNotes({
    id: `an-${now.toString(36)}-${randomBytes(2).toString('hex')}`,
    courseId: id,
    chapterIndex,
    quote,
    occurrence: clampInt(body.occurrence, 0, 999, 0),
    color: normalizeAnnotationColor(typeof body.color === 'string' ? body.color : ''),
    style: normalizeAnnotationStyle(typeof body.style === 'string' ? body.style : ''),
    note: noteText,
    notes: noteText === '' ? [] : [{ id: `nt-${now.toString(36)}-${randomBytes(2).toString('hex')}`, text: noteText, createdAt: now, updatedAt: 0 }],
    createdAt: now,
    updatedAt: now,
  })
  items.unshift(annotation)
  await writeJsonAtomic(join(dir, 'annotations.json'), items.slice(0, 500))
  return { annotation }
}

async function apiUpdateAnnotation(body) {
  const id = body.id
  assertId(id)
  const annotationId = typeof body.annotationId === 'string' ? body.annotationId : ''
  const dir = courseDir(id)
  const items = await readAnnotations(dir)
  const annotation = items.find((item) => item !== null && typeof item === 'object' && item.id === annotationId)
  if (annotation === undefined) throw httpError('NOT_FOUND', '标注不存在')
  ensureAnnotationNotes(annotation)
  const now = Date.now()
  if (typeof body.appendNote === 'string' && body.appendNote.trim() !== '') {
    annotation.notes.push({
      id: `nt-${now.toString(36)}-${randomBytes(2).toString('hex')}`,
      text: body.appendNote.trim().slice(0, 2000),
      createdAt: now,
      updatedAt: 0,
    })
  }
  if (typeof body.deleteNoteId === 'string' && body.deleteNoteId !== '') {
    annotation.notes = annotation.notes.filter((note) => note.id !== body.deleteNoteId)
  }
  if (typeof body.noteId === 'string' && body.noteId !== '' && typeof body.noteText === 'string') {
    const target = annotation.notes.find((note) => note.id === body.noteId)
    if (target !== undefined) {
      target.text = body.noteText.trim().slice(0, 2000)
      target.updatedAt = now
    }
  }
  if (typeof body.note === 'string' && body.appendNote === undefined) {
    const text = body.note.trim().slice(0, 2000)
    annotation.notes = text === '' ? [] : [{ id: `nt-${now.toString(36)}-${randomBytes(2).toString('hex')}`, text, createdAt: now, updatedAt: 0 }]
  }
  ensureAnnotationNotes(annotation)
  if (typeof body.color === 'string') annotation.color = normalizeAnnotationColor(body.color)
  if (typeof body.style === 'string') annotation.style = normalizeAnnotationStyle(body.style)
  annotation.updatedAt = now
  await writeJsonAtomic(join(dir, 'annotations.json'), items)
  return { annotation }
}

async function apiDeleteAnnotation(body) {
  const id = body.id
  assertId(id)
  const annotationId = typeof body.annotationId === 'string' ? body.annotationId : ''
  const dir = courseDir(id)
  const items = await readAnnotations(dir)
  const next = items.filter((item) => item === null || typeof item !== 'object' || item.id !== annotationId)
  if (next.length === items.length) throw httpError('NOT_FOUND', '标注不存在')
  await writeJsonAtomic(join(dir, 'annotations.json'), next)
  return { deleted: annotationId }
}

/* ------------------------------------------------------------------ */
/* Study plan (manual scheduled tasks)                                 */
/* ------------------------------------------------------------------ */

async function readStudyPlan(dir) {
  const stored = await readJsonFile(join(dir, 'course.json'), null)
  if (stored === null) throw httpError('NOT_FOUND', '课程不存在')
  return { stored, items: normalizeStudyPlan(stored.studyPlan) }
}

async function apiPlanAdd(body) {
  const id = body.id
  assertId(id)
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  if (title === '') throw httpError('BAD_REQUEST', '任务标题不能为空')
  const dueAt = Number(body.dueAt)
  const chapterIndex = Number(body.chapterIndex)
  const dir = courseDir(id)
  const { stored, items } = await readStudyPlan(dir)
  const now = Date.now()
  const item = {
    id: `pl-${now.toString(36)}-${randomBytes(2).toString('hex')}`,
    title,
    detail: typeof body.detail === 'string' ? body.detail.trim().slice(0, 500) : '',
    dueAt: Number.isFinite(dueAt) && dueAt > 0 ? dueAt : now + 60 * 60 * 1000,
    status: 'pending',
    chapterIndex: Number.isInteger(chapterIndex) && chapterIndex >= 0 ? chapterIndex : null,
    conceptName: typeof body.conceptName === 'string' ? body.conceptName.trim().slice(0, 80) : '',
    source: body.source === 'suggestion' ? 'suggestion' : 'manual',
    createdAt: now,
    completedAt: 0,
  }
  items.unshift(item)
  stored.studyPlan = items.slice(0, 200)
  stored.updatedAt = now
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  return { studyPlan: stored.studyPlan }
}

async function apiPlanUpdate(body) {
  const id = body.id
  assertId(id)
  const itemId = typeof body.itemId === 'string' ? body.itemId : ''
  const dir = courseDir(id)
  const { stored, items } = await readStudyPlan(dir)
  const item = items.find((entry) => entry.id === itemId)
  if (item === undefined) throw httpError('NOT_FOUND', '计划任务不存在')
  if (typeof body.title === 'string' && body.title.trim() !== '') item.title = body.title.trim().slice(0, 200)
  if (typeof body.detail === 'string') item.detail = body.detail.trim().slice(0, 500)
  if (Number.isFinite(Number(body.dueAt)) && Number(body.dueAt) > 0) item.dueAt = Number(body.dueAt)
  if (body.status === 'done' || body.status === 'pending') {
    item.status = body.status
    item.completedAt = body.status === 'done' ? Date.now() : 0
  }
  stored.studyPlan = items
  stored.updatedAt = Date.now()
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  return { studyPlan: items }
}

async function apiPlanDelete(body) {
  const id = body.id
  assertId(id)
  const itemId = typeof body.itemId === 'string' ? body.itemId : ''
  const dir = courseDir(id)
  const { stored, items } = await readStudyPlan(dir)
  const next = items.filter((entry) => entry.id !== itemId)
  if (next.length === items.length) throw httpError('NOT_FOUND', '计划任务不存在')
  stored.studyPlan = next
  stored.updatedAt = Date.now()
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  return { studyPlan: next }
}

/* ------------------------------------------------------------------ */
/* Wrong-answer retraining                                             */
/* ------------------------------------------------------------------ */

async function readRetrainVariants(dir) {
  const store = await readJsonFile(join(dir, 'retrain-variants.json'), {})
  return store !== null && typeof store === 'object' && !Array.isArray(store) ? store : {}
}

async function generateRetrainVariant(ctx, { course, chapterIndex, question }) {
  const originalConcepts = Array.isArray(question.concepts) ? question.concepts.filter((name) => typeof name === 'string' && name.trim() !== '') : []
  const system = [
    '你是一位出题老师，负责为做错的学生生成同知识点的变式题。',
    '只输出单个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。',
  ].join('\n')
  const prompt = [
    `课程：《${course.title}》`,
    `章节：《${course.outline?.[chapterIndex]?.title ?? `第 ${chapterIndex + 1} 章`}》`,
    `学生做错的原题：${question.question}`,
    Array.isArray(question.options) ? `原选项：${question.options.join(' / ')}` : '',
    originalConcepts.length > 0 ? `考察概念：${originalConcepts.join('、')}` : '',
    '',
    '请出一道同知识点、同难度的变式单选题：换情境/换数字/换提问角度，但考察同一概念，不要照抄原题。',
    '要求：',
    '1. 4 个选项，只有一个正确答案，不要「以上都对/都不对」。',
    '2. 给出 explanation 解析。',
    '3. 题目必须绑定 1-2 个考察概念（逐字复用上面的概念名），放在 concepts 数组。',
    '4. 只输出 JSON：{"questions":[{"question":"题干","options":["A","B","C","D"],"answerIndex":0,"explanation":"解析","concepts":["概念名"]}]}',
  ]
    .filter((line) => line !== '')
    .join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 2200 })
  const parsed = extractJson(raw)
  const knownConcepts = originalConcepts.length > 0 ? originalConcepts : chapterConceptNamesFromData(course.chapters?.[chapterIndex], course.outline?.[chapterIndex])
  const questions = normalizeAssessmentQuestions(parsed, knownConcepts, 1)
  if (questions.length === 0) throw httpError('PARSE_FAILED', '没有生成可用的变式题，请重试')
  return questions[0]
}

async function apiRetrainQuestion(ctx, body) {
  const id = body.id
  assertId(id)
  const chapterIndex = Number(body.chapterIndex)
  const questionIndex = Number(body.questionIndex)
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw httpError('BAD_REQUEST', '非法章节序号')
  if (!Number.isInteger(questionIndex) || questionIndex < 0) throw httpError('BAD_REQUEST', '非法题目序号')
  const course = await loadCourse(id)
  const chapter = course.chapters?.[chapterIndex]
  const question = chapter === null || chapter === undefined ? undefined : chapter.quiz?.questions?.[questionIndex]
  if (question === undefined || question === null || typeof question !== 'object') throw httpError('NOT_FOUND', '错题不存在')
  const variant = body.variant === true
  if (!variant) {
    return {
      question: {
        question: question.question,
        options: Array.isArray(question.options) ? question.options : [],
        concepts: Array.isArray(question.concepts) ? question.concepts : [],
      },
      variant: false,
    }
  }
  const dir = courseDir(id)
  const key = `${chapterIndex}:${questionIndex}`
  const store = await readRetrainVariants(dir)
  let entry = store[key]
  if (entry === undefined || entry === null || typeof entry !== 'object' || entry.question === undefined) {
    const generated = await generateRetrainVariant(ctx, { course, chapterIndex, question })
    entry = { question: generated, generatedAt: Date.now() }
    store[key] = entry
    await writeJsonAtomic(join(dir, 'retrain-variants.json'), store)
  }
  return {
    question: {
      question: entry.question.question,
      options: Array.isArray(entry.question.options) ? entry.question.options : [],
      concepts: Array.isArray(entry.question.concepts) ? entry.question.concepts : [],
    },
    variant: true,
    generatedAt: entry.generatedAt ?? 0,
  }
}

async function apiRetrainAnswer(body) {
  const id = body.id
  assertId(id)
  const chapterIndex = Number(body.chapterIndex)
  const questionIndex = Number(body.questionIndex)
  const answer = Number(body.answer)
  const variant = body.variant === true
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw httpError('BAD_REQUEST', '非法章节序号')
  if (!Number.isInteger(questionIndex) || questionIndex < 0) throw httpError('BAD_REQUEST', '非法题目序号')
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) throw httpError('BAD_REQUEST', '请选择一个选项')
  const course = await loadCourse(id)
  const chapter = course.chapters?.[chapterIndex]
  const original = chapter === null || chapter === undefined ? undefined : chapter.quiz?.questions?.[questionIndex]
  if (original === undefined || original === null || typeof original !== 'object') throw httpError('NOT_FOUND', '错题不存在')
  const dir = courseDir(id)
  const key = `${chapterIndex}:${questionIndex}`
  let question = original
  let questionConcepts = Array.isArray(original.concepts) ? original.concepts : []
  if (variant) {
    const store = await readRetrainVariants(dir)
    const entry = store[key]
    if (entry === undefined || entry === null || typeof entry !== 'object' || entry.question === undefined) {
      throw httpError('BAD_REQUEST', '请先生成变式题')
    }
    question = entry.question
    questionConcepts = Array.isArray(question.concepts) ? question.concepts : questionConcepts
  }
  const correctIndex = Number(question.answerIndex)
  const correct = answer === correctIndex
  const stored = await readJsonFile(join(dir, 'course.json'), null)
  if (stored === null) throw httpError('NOT_FOUND', '课程不存在')
  const progress = normalizeProgress(stored.progress)
  const previous = progress.retrain[key] ?? { attempts: 0, correct: 0, resolved: false, lastAt: 0 }
  progress.retrain[key] = {
    attempts: previous.attempts + 1,
    correct: previous.correct + (correct ? 1 : 0),
    resolved: correct || previous.resolved === true,
    lastAt: Date.now(),
  }
  const knownConcepts = chapterConceptNamesFromData(chapter, course.outline?.[chapterIndex])
  const merged = mergeConceptStats(progress.concepts ?? {}, knownConcepts, [question], [answer], Date.now())
  progress.concepts = sanitizeConceptStats(merged)
  progress.updatedAt = Date.now()
  stored.progress = progress
  stored.progressUpdatedAt = progress.updatedAt
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  const updated = await loadCourse(id)
  stored.curriculum = {
    ...(stored.curriculum ?? {}),
    initialUnlocked: updated.curriculum.initialUnlocked,
    masteryThreshold: updated.curriculum.masteryThreshold,
    stageSize: updated.curriculum.stageSize,
    stageThreshold: updated.curriculum.stageThreshold,
    unlockStep: 1,
    unlocked: updated.curriculum.unlocked,
  }
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  return {
    correct,
    correctIndex,
    explanation: typeof question.explanation === 'string' ? question.explanation : '',
    resolved: progress.retrain[key].resolved,
    retrain: progress.retrain[key],
    progress: updated.progress,
    curriculum: updated.curriculum,
    mastery: updated.mastery,
  }
}

/* ------------------------------------------------------------------ */
/* Stage assessments                                                   */
/* ------------------------------------------------------------------ */

function normalizeAssessmentQuestions(parsed, knownConcepts, maxQuestions) {
  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : []
  const questions = []
  const known = new Set(knownConcepts)
  for (const item of rawQuestions) {
    if (item === null || typeof item !== 'object') continue
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    const options = Array.isArray(item.options)
      ? item.options.filter((option) => typeof option === 'string' && option.trim() !== '').map((option) => option.trim()).slice(0, 4)
      : []
    const answerIndex = Number(item.answerIndex)
    const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : ''
    if (question === '' || options.length !== 4) continue
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) continue
    let bound = Array.isArray(item.concepts)
      ? item.concepts
          .filter((name) => typeof name === 'string' && name.trim() !== '')
          .map((name) => name.trim())
          .filter((name) => known.size === 0 || known.has(name))
      : []
    if (bound.length === 0 && knownConcepts.length > 0) {
      const haystack = `${question} ${options.join(' ')}`
      bound = knownConcepts.filter((name) => haystack.includes(name)).slice(0, 2)
    }
    if (bound.length === 0 && knownConcepts.length > 0) bound = knownConcepts.slice(0, 2)
    questions.push({ question, options, answerIndex, explanation, concepts: [...new Set(bound)] })
    if (questions.length >= maxQuestions) break
  }
  return questions
}

function stageConceptNames(course, stage) {
  const names = []
  for (const index of stage.chapterIndexes) {
    const chapterNames = chapterConceptNamesFromData(course.chapters?.[index], course.outline?.[index])
    for (const name of chapterNames) if (!names.includes(name)) names.push(name)
  }
  return names
}

async function generateStageAssessment(ctx, { course, stage }) {
  const chapterInfos = stage.chapterIndexes.map((index) => {
    const outline = course.outline?.[index] ?? {}
    return {
      index,
      title: outline.title ?? `第 ${index + 1} 章`,
      summary: typeof outline.summary === 'string' ? outline.summary : '',
      concepts: chapterConceptNamesFromData(course.chapters?.[index], outline),
    }
  })
  const allConcepts = [...new Set(chapterInfos.flatMap((item) => item.concepts))]
  const system = [
    '你是一位出题老师，负责为一个学习阶段出综合测评题。',
    '只输出单个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。',
  ].join('\n')
  const prompt = [
    `课程：《${course.title}》`,
    `阶段：${stage.title}（第 ${stage.startChapterIndex + 1} - ${stage.endChapterIndex + 1} 章）`,
    '',
    '本阶段章节与核心概念：',
    ...chapterInfos.map((item) => `- 第 ${item.index + 1} 章《${item.title}》：${item.concepts.join('、') || '（无概念）'}`),
    allConcepts.length > 0 ? `全部概念：${allConcepts.join('、')}` : '',
    '',
    '要求：',
    '1. 出 5 道中文单选题，覆盖本阶段全部章节，优先考跨章联系、应用和易混点，不要只考单章记忆。',
    '2. 每题 4 个选项，只有一个正确答案；不要「以上都对/都不对」。',
    '3. 每题给 explanation 解析。',
    '4. 每题绑定 1-2 个考察概念，概念名逐字复用上面「全部概念」中的名称，放在 concepts 数组。',
    '5. 只输出 JSON：{"questions":[{"question":"题干","options":["A","B","C","D"],"answerIndex":0,"explanation":"解析","concepts":["概念名"]}]}',
  ]
    .filter((line) => line !== '')
    .join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 3200 })
  const parsed = extractJson(raw)
  const questions = normalizeAssessmentQuestions(parsed, allConcepts, 5)
  if (questions.length === 0) throw httpError('PARSE_FAILED', '模型没有返回可用的阶段测评题')
  return { questions }
}

async function readAssessmentStore(dir) {
  const store = await readJsonFile(join(dir, 'assessments.json'), {})
  return store !== null && typeof store === 'object' && !Array.isArray(store) ? store : {}
}

async function apiAssessment(ctx, body) {
  const id = body.id
  assertId(id)
  const stageIndex = Number(body.stageIndex)
  if (!Number.isInteger(stageIndex) || stageIndex < 0) throw httpError('BAD_REQUEST', '非法阶段序号')
  const course = await loadCourse(id)
  const stage = course.curriculum.stages?.[stageIndex]
  if (stage === undefined) throw httpError('NOT_FOUND', '阶段不存在')
  if (!stage.available) throw httpError('BAD_REQUEST', '请先解锁本阶段全部章节')
  const dir = courseDir(id)
  const store = await readAssessmentStore(dir)
  const cachedEntry = store[stageIndex]
  const cached = cachedEntry !== undefined && Array.isArray(cachedEntry.questions) && cachedEntry.questions.length > 0
  if (cached && body.force !== true) {
    return {
      assessment: {
        stageIndex,
        title: stage.title,
        questions: cachedEntry.questions,
        generatedAt: Number(cachedEntry.generatedAt) || 0,
        cached: true,
      },
    }
  }
  const generated = await generateStageAssessment(ctx, { course, stage })
  const entry = { stageIndex, questions: generated.questions, generatedAt: Date.now() }
  store[stageIndex] = entry
  await writeJsonAtomic(join(dir, 'assessments.json'), store)
  return { assessment: { stageIndex, title: stage.title, questions: entry.questions, generatedAt: entry.generatedAt, cached: false } }
}

async function apiSubmitAssessment(body) {
  const id = body.id
  assertId(id)
  const stageIndex = Number(body.stageIndex)
  if (!Number.isInteger(stageIndex) || stageIndex < 0) throw httpError('BAD_REQUEST', '非法阶段序号')
  const answers = Array.isArray(body.answers) ? body.answers.map(Number) : []
  const course = await loadCourse(id)
  const stage = course.curriculum.stages?.[stageIndex]
  if (stage === undefined) throw httpError('NOT_FOUND', '阶段不存在')
  const dir = courseDir(id)
  const store = await readAssessmentStore(dir)
  const cachedEntry = store[stageIndex]
  if (cachedEntry === undefined || !Array.isArray(cachedEntry.questions) || cachedEntry.questions.length === 0) {
    throw httpError('BAD_REQUEST', '请先生成阶段测评')
  }
  const questions = cachedEntry.questions
  if (answers.length !== questions.length || answers.some((value) => !Number.isInteger(value) || value < 0 || value > 3)) {
    throw httpError('BAD_REQUEST', '请完成全部题目后再提交')
  }
  const score = questions.reduce((total, question, index) => total + (answers[index] === Number(question.answerIndex) ? 1 : 0), 0)
  const total = questions.length
  const percent = total > 0 ? Math.round((score / total) * 100) : 0
  const stored = await readJsonFile(join(dir, 'course.json'), null)
  if (stored === null) throw httpError('NOT_FOUND', '课程不存在')
  const progress = normalizeProgress(stored.progress)
  const conceptNames = stageConceptNames(course, stage)
  const merged = mergeConceptStats(progress.concepts ?? {}, conceptNames, questions, answers, Date.now())
  progress.concepts = sanitizeConceptStats(merged)
  progress.assessments = progress.assessments ?? {}
  progress.assessments[stageIndex] = {
    score,
    total,
    answers,
    at: Date.now(),
    passed: percent >= course.curriculum.stageThreshold,
  }
  progress.updatedAt = Date.now()
  stored.progress = progress
  stored.progressUpdatedAt = progress.updatedAt
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  const updated = await loadCourse(id)
  const previousUnlocked = new Set(Array.isArray(stored.curriculum?.unlocked) ? stored.curriculum.unlocked : [])
  const newlyUnlocked = updated.curriculum.unlocked.filter((index) => !previousUnlocked.has(index))
  stored.curriculum = {
    ...(stored.curriculum ?? {}),
    initialUnlocked: updated.curriculum.initialUnlocked,
    masteryThreshold: updated.curriculum.masteryThreshold,
    stageSize: updated.curriculum.stageSize,
    stageThreshold: updated.curriculum.stageThreshold,
    unlockStep: 1,
    unlocked: updated.curriculum.unlocked,
  }
  await writeJsonAtomic(join(dir, 'course.json'), stored)
  return {
    progress: updated.progress,
    curriculum: updated.curriculum,
    mastery: updated.mastery,
    result: { score, total, percent, passed: percent >= updated.curriculum.stageThreshold },
    newlyUnlocked,
  }
}

/* ------------------------------------------------------------------ */
/* Knowledge graph                                                     */
/* ------------------------------------------------------------------ */

function buildGraphFromLoaded(course, previousGraph, unlockedSet) {
  const nodes = []
  const labelToId = new Map()
  const chapterNodes = new Map()
  const createdFor = new Map()
  const outline = Array.isArray(course.outline) ? course.outline : []
  const chapters = Array.isArray(course.chapters) ? course.chapters : []
  for (let chapterIndex = 0; chapterIndex < outline.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex]
    const conceptRecords = Array.isArray(chapter?.concepts?.concepts) ? chapter.concepts.concepts : null
    const sourceConcepts =
      conceptRecords !== null && conceptRecords.length > 0
        ? conceptRecords
            .filter((concept) => concept !== null && typeof concept === 'object' && typeof concept.name === 'string')
            .map((concept) => ({ name: concept.name.trim(), definition: concept.definition, difficulty: concept.difficulty }))
        : (Array.isArray(outline[chapterIndex]?.concepts) ? outline[chapterIndex].concepts : [])
            .filter((name) => typeof name === 'string' && name.trim() !== '')
            .map((name) => ({ name: name.trim() }))
    const list = []
    for (const concept of sourceConcepts) {
      const label = concept.name
      if (label === '') continue
      const id = `c${chapterIndex}-${list.length + 1}`
      if (labelToId.has(label)) {
        list.push({ id: labelToId.get(label), label, record: concept })
        continue
      }
      const node = {
        id,
        label,
        chapterIndex,
        chapterTitle: outline[chapterIndex]?.title ?? `第 ${chapterIndex + 1} 章`,
        kind: 'concept',
        locked: !unlockedSet.has(chapterIndex),
        chapterGenerated: Boolean(chapter),
        ...(typeof concept.definition === 'string' && concept.definition.trim() !== ''
          ? { definition: concept.definition.trim() }
          : {}),
        ...(Number.isFinite(concept.difficulty) ? { difficulty: concept.difficulty } : {}),
      }
      labelToId.set(label, id)
      createdFor.set(id, concept)
      nodes.push(node)
      list.push({ id, label, record: concept })
    }
    if (list.length > 0) chapterNodes.set(chapterIndex, list)
  }

  const edges = []
  const seen = new Set()
  const addEdge = (source, target, relation) => {
    if (source === undefined || target === undefined || source === target) return
    if (!GRAPH_RELATIONS.has(relation)) return
    const key = `${source}->${target}:${relation}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source, target, relation })
  }
  for (const node of nodes) {
    const record = createdFor.get(node.id)
    if (record === undefined || !Array.isArray(record.prerequisites)) continue
    for (const prerequisiteName of record.prerequisites) {
      if (typeof prerequisiteName !== 'string') continue
      const sourceId = labelToId.get(prerequisiteName.trim())
      if (sourceId !== undefined) addEdge(sourceId, node.id, 'prerequisite')
    }
  }
  if (previousGraph !== null && previousGraph !== undefined && Array.isArray(previousGraph.nodes) && Array.isArray(previousGraph.edges)) {
    const previousIdToLabel = new Map(
      previousGraph.nodes
        .filter((node) => node !== null && typeof node === 'object' && typeof node.id === 'string' && typeof node.label === 'string')
        .map((node) => [node.id, node.label]),
    )
    for (const edge of previousGraph.edges) {
      if (edge === null || typeof edge !== 'object') continue
      const fromLabel = previousIdToLabel.get(edge.source)
      const toLabel = previousIdToLabel.get(edge.target)
      const from = fromLabel === undefined ? undefined : labelToId.get(fromLabel)
      const to = toLabel === undefined ? undefined : labelToId.get(toLabel)
      if (from === undefined || to === undefined) continue
      if (edge.relation === 'related' || edge.relation === 'contrast' || edge.relation === 'prerequisite') {
        addEdge(from, to, edge.relation)
      }
    }
  }
  for (const list of chapterNodes.values()) {
    for (let index = 0; index + 1 < list.length; index += 1) {
      const hasDirect = edges.some(
        (edge) =>
          (edge.source === list[index].id && edge.target === list[index + 1].id) ||
          (edge.source === list[index + 1].id && edge.target === list[index].id),
      )
      if (!hasDirect) addEdge(list[index].id, list[index + 1].id, 'related')
    }
  }
  const chapterIndexes = [...chapterNodes.keys()].sort((a, b) => a - b)
  for (let index = 0; index + 1 < chapterIndexes.length; index += 1) {
    const from = chapterNodes.get(chapterIndexes[index])
    const to = chapterNodes.get(chapterIndexes[index + 1])
    if (from.length > 0 && to.length > 0) addEdge(from[from.length - 1].id, to[0].id, 'prerequisite')
  }
  return {
    nodes,
    edges: edges.slice(0, 160),
    chapters: outline.map((chapter, chapterIndex) => ({
      index: chapterIndex,
      title: chapter?.title ?? `第 ${chapterIndex + 1} 章`,
      locked: !unlockedSet.has(chapterIndex),
    })),
    source: 'concepts',
    generatedAt: Date.now(),
  }
}

async function rebuildGraphForCourse(id, force = false) {
  const course = await loadCourse(id)
  const dir = courseDir(id)
  const previousGraph = force ? null : await readJsonFile(join(dir, 'graph.json'), null)
  const graph = buildGraphFromLoaded(course, previousGraph, new Set(course.curriculum.unlocked))
  await writeJsonAtomic(join(dir, 'graph.json'), graph)
  const stored = await readJsonFile(join(dir, 'course.json'), null)
  if (stored !== null) {
    stored.hasGraph = true
    stored.graphUpdatedAt = Date.now()
    await writeJsonAtomic(join(dir, 'course.json'), stored)
  }
  return graph
}

async function apiGraph(ctx, body, res) {
  const id = body.id
  assertId(id)
  const graph = await rebuildGraphForCourse(id, body.force === true)
  return { graph }
}

function graphNodesFromOutline(course) {
  const nodes = []
  const labelToId = new Map()
  const outline = Array.isArray(course.outline) ? course.outline : []
  outline.forEach((chapter, chapterIndex) => {
    const concepts =
      Array.isArray(chapter.concepts) && chapter.concepts.length > 0 ? chapter.concepts : [chapter.title]
    for (const concept of concepts) {
      const label = typeof concept === 'string' ? concept.trim() : ''
      if (label === '' || labelToId.has(label)) continue
      const node = {
        id: `n${nodes.length + 1}`,
        label,
        chapterIndex,
        chapterTitle: chapter.title,
        kind: 'concept',
      }
      labelToId.set(label, node.id)
      nodes.push(node)
    }
  })
  return { nodes, labelToId }
}

function derivedGraphEdges(nodes) {
  const edges = []
  const byChapter = new Map()
  for (const node of nodes) {
    const list = byChapter.get(node.chapterIndex) ?? []
    list.push(node)
    byChapter.set(node.chapterIndex, list)
  }
  for (const list of byChapter.values()) {
    for (let index = 0; index + 1 < list.length; index += 1) {
      edges.push({ source: list[index].id, target: list[index + 1].id, relation: 'related' })
    }
  }
  const chapters = [...byChapter.keys()].sort((a, b) => a - b)
  for (let index = 0; index + 1 < chapters.length; index += 1) {
    const from = byChapter.get(chapters[index])
    const to = byChapter.get(chapters[index + 1])
    if (from.length > 0 && to.length > 0) {
      edges.push({ source: from[from.length - 1].id, target: to[0].id, relation: 'prerequisite' })
    }
  }
  return edges
}

const GRAPH_RELATIONS = new Set(['prerequisite', 'related', 'contrast'])

async function generateGraph(ctx, { course, signal }) {
  const { nodes, labelToId } = graphNodesFromOutline(course)
  const route = routeOf(ctx)
  let edges = []
  let source = 'derived'
  if (nodes.length >= 3) {
    try {
      const system = [
        '你是一位知识图谱设计者，负责梳理课程概念之间的依赖与关联。',
        '只输出单个 JSON 对象，不要 Markdown 代码围栏，不要解释文字。',
      ].join('\n')
      const outlineText = course.outline
        .map((chapter, index) => {
          const concepts = nodes.filter((node) => node.chapterIndex === index).map((node) => `  - ${node.label}`)
          return `第 ${index + 1} 章 ${chapter.title}\n${concepts.join('\n')}`
        })
        .join('\n')
      const prompt = [
        `课程：《${course.title}》（${DOMAINS[course.domain] ?? '通用通识'}，${LEVELS[course.level] ?? '入门'}）`,
        '',
        '章节与概念：',
        outlineText,
        '',
        '请只使用上面逐字出现过的概念标签作为 source / target，建立概念之间的有向关系，输出：',
        '{"edges":[{"source":"概念A","target":"概念B","relation":"prerequisite"}]}',
        '',
        'relation 取值：',
        '- prerequisite：先掌握 source 才能学 target',
        '- related：两个概念相关',
        '- contrast：两个概念容易混淆、需要对比',
        '',
        '要求：',
        '1. 12-40 条边，尽量让每个概念至少出现一次。',
        '2. 不要自环；同一对概念只保留一条边。',
        '3. 优先给出跨章节的前置关系（后面的章节通常依赖前面章节的概念）。',
        '4. 只输出 JSON。',
      ].join('\n')
      const raw = await callModel(ctx, { system, prompt, maxTokens: 4000, signal })
      const parsed = extractJson(raw)
      const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : []
      const seen = new Set()
      for (const item of rawEdges) {
        if (item === null || typeof item !== 'object') continue
        const fromLabel = typeof item.source === 'string' ? item.source.trim() : ''
        const toLabel = typeof item.target === 'string' ? item.target.trim() : ''
        const relation = typeof item.relation === 'string' ? item.relation.trim() : ''
        const from = labelToId.get(fromLabel)
        const to = labelToId.get(toLabel)
        if (from === undefined || to === undefined || from === to) continue
        if (!GRAPH_RELATIONS.has(relation)) continue
        const key = `${from}->${to}:${relation}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ source: from, target: to, relation })
        if (edges.length >= 80) break
      }
      if (edges.length >= 3) source = 'llm'
    } catch (error) {
      ctx.logger?.warn?.(`learning-space: graph model call failed, falling back to derived edges: ${error?.message ?? error}`)
      edges = []
      source = 'derived'
    }
  }
  if (edges.length === 0) edges = derivedGraphEdges(nodes)
  return {
    nodes,
    edges,
    chapters: (Array.isArray(course.outline) ? course.outline : []).map((chapter, index) => ({
      index,
      title: chapter.title,
    })),
    source,
    model: route,
    generatedAt: Date.now(),
  }
}

function makeCourseId() {
  const now = new Date()
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  const time = [String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')].join('')
  return `c-${date}-${time}-${randomBytes(2).toString('hex')}`
}

function normalizeDomain(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOMAINS, value) ? value : 'general'
}

function normalizeLevel(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : 'beginner'
}

async function apiOutline(ctx, body) {
  const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
  if (topic.length < 2) throw httpError('BAD_REQUEST', '请先填写课程主题（至少 2 个字）')
  if (topic.length > 200) throw httpError('BAD_REQUEST', '课程主题过长')
  const domain = normalizeDomain(body.domain)
  const level = normalizeLevel(body.level)
  const rawCount = Number(body.chapterCount)
  const chapterCount = Number.isFinite(rawCount) ? Math.min(12, Math.max(3, Math.round(rawCount))) : 6
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : ''

  const id = makeCourseId()
  const dir = courseDir(id)
  const courseMd = await generateOutline(ctx, { topic, domain, level, chapterCount, notes })
  const now = Date.now()
  const totalChapters = courseMd.chapters.length
  const initialUnlocked = clampInt(
    body.initialUnlocked,
    1,
    totalChapters,
    Math.min(DEFAULT_INITIAL_UNLOCKED, totalChapters),
  )
  const masteryThreshold = clampInt(body.masteryThreshold, 30, 100, DEFAULT_MASTERY_THRESHOLD)
  const stageSize = clampInt(body.stageSize, 2, 12, 3)
  const stageThreshold = clampInt(body.stageThreshold, 30, 100, masteryThreshold)
  const course = {
    id,
    title: courseMd.title || topic,
    topic,
    domain,
    level,
    chapterCount: totalChapters,
    status: 'planned',
    createdAt: now,
    updatedAt: now,
    model: routeOf(ctx),
    outline: courseMd.chapters,
    generated: [],
    curriculum: {
      initialUnlocked,
      masteryThreshold,
      stageSize,
      stageThreshold,
      unlockStep: 1,
      unlocked: Array.from({ length: initialUnlocked }, (_, index) => index),
    },
  }
  await mkdir(join(dir, 'chapters'), { recursive: true })
  await writeJsonAtomic(join(dir, 'course.json'), course)
  return { course: await loadCourse(id) }
}

function jobKey(courseId, index) {
  return `${courseId}:${index}`
}

function pruneJobs(now = Date.now()) {
  for (const [id, job] of chapterJobs) {
    const running = job.status === 'running' || job.status === 'queued'
    if (!running && now - job.updatedAt > JOB_TTL_MS) {
      chapterJobs.delete(id)
      if (activeChapterJobs.get(jobKey(job.courseId, job.index)) === id) {
        activeChapterJobs.delete(jobKey(job.courseId, job.index))
      }
    }
  }
  while (chapterJobs.size > MAX_JOBS) {
    const first = chapterJobs.keys().next().value
    if (first === undefined) break
    const job = chapterJobs.get(first)
    if (job !== undefined && (job.status === 'running' || job.status === 'queued')) break
    chapterJobs.delete(first)
  }
}

function createChapterJob(courseId, index) {
  pruneJobs()
  const id = `job-${Date.now().toString(36)}-${++jobCounter}`
  const job = {
    id,
    courseId,
    index,
    status: 'queued',
    currentStep: null,
    steps: JOB_STEP_DEFS.map((step) => ({ key: step.key, label: step.label, status: 'pending', detail: '' })),
    warnings: [],
    error: null,
    result: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    cancelled: false,
    controller: new AbortController(),
  }
  chapterJobs.set(id, job)
  activeChapterJobs.set(jobKey(courseId, index), id)
  return job
}

function stepOf(job, key) {
  return job.steps.find((step) => step.key === key)
}

function setStep(job, key, status, detail) {
  const step = stepOf(job, key)
  if (step === undefined) return
  step.status = status
  if (typeof detail === 'string') step.detail = detail
  job.currentStep = key
  job.updatedAt = Date.now()
}

function jobSnapshot(job) {
  return {
    id: job.id,
    courseId: job.courseId,
    index: job.index,
    status: job.status,
    currentStep: job.currentStep,
    steps: job.steps.map((step) => ({ key: step.key, label: step.label, status: step.status, detail: step.detail })),
    warnings: [...job.warnings],
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    result: job.status === 'succeeded' && job.result !== null ? job.result : null,
    ...(job.status === 'failed' && typeof job.draftMarkdown === 'string'
      ? { draftMarkdown: job.draftMarkdown }
      : {}),
  }
}

async function apiChapter(ctx, body) {
  const id = body.id
  assertId(id)
  const index = Number(body.index)
  if (!Number.isInteger(index) || index < 0) throw httpError('BAD_REQUEST', '非法章节序号')
  const course = await loadCourse(id)
  const outline = course.outline[index]
  if (outline === undefined) throw httpError('NOT_FOUND', '章节不存在')
  if (!course.curriculum.legacy && !course.curriculum.unlocked.includes(index)) {
    throw httpError('LOCKED', `第 ${index + 1} 章尚未解锁`, { nextUnlock: course.curriculum.nextUnlock })
  }

  const dir = courseDir(id)
  const stem = chapterStem(index)
  const chapterPath = join(dir, 'chapters', `${stem}.md`)
  if (body.force !== true) {
    const existing = await readFile(chapterPath, 'utf8').catch(() => null)
    if (existing !== null && existing.trim() !== '') {
      const quiz = await readJsonFile(join(dir, 'chapters', `${stem}.quiz.json`), null)
      const concepts = await readJsonFile(join(dir, 'chapters', `${stem}.concepts.json`), null)
      return {
        chapter: { index, number: index + 1, title: outline.title, markdown: existing, quiz, concepts },
      }
    }
  }

  const key = jobKey(id, index)
  const runningId = activeChapterJobs.get(key)
  if (runningId !== undefined) {
    const running = chapterJobs.get(runningId)
    if (running !== undefined && (running.status === 'running' || running.status === 'queued')) {
      return { job: jobSnapshot(running), reused: true }
    }
    activeChapterJobs.delete(key)
  }

  const job = createChapterJob(id, index)
  if (body.sync === true) {
    await runChapterJob(ctx, job)
    const snapshot = jobSnapshot(job)
    if (job.status !== 'succeeded' || job.result === null) {
      throw httpError('JOB_FAILED', job.error?.message ?? '章节生成失败', { job: snapshot })
    }
    return { chapter: job.result.chapter, job: snapshot }
  }
  void runChapterJob(ctx, job).catch((error) => {
    ctx.logger?.warn?.(`learning-space: chapter job ${job.id} failed unexpectedly: ${error?.message ?? error}`)
  })
  return { job: jobSnapshot(job) }
}

async function apiJob(body) {
  const jobId = typeof body.jobId === 'string' ? body.jobId : ''
  const job = chapterJobs.get(jobId)
  if (job === undefined) throw httpError('NOT_FOUND', '生成任务不存在或已过期')
  return { job: jobSnapshot(job) }
}

async function apiCancelJob(body) {
  const jobId = typeof body.jobId === 'string' ? body.jobId : ''
  const job = chapterJobs.get(jobId)
  if (job === undefined) throw httpError('NOT_FOUND', '生成任务不存在或已过期')
  if (job.status === 'running' || job.status === 'queued') {
    job.cancelled = true
    job.status = 'cancelled'
    job.updatedAt = Date.now()
    const current = job.currentStep === null ? null : stepOf(job, job.currentStep)
    if (current !== null && current.status === 'running') current.status = 'cancelled'
    job.controller.abort()
  }
  return { job: jobSnapshot(job) }
}

async function runChapterJob(ctx, job) {
  const timeout = setTimeout(() => {
    if (job.status === 'running' || job.status === 'queued') {
      job.controller.abort()
    }
  }, JOB_TIMEOUT_MS)
  const signal = job.controller.signal
  const fail = (error) => {
    if (job.cancelled) {
      job.status = 'cancelled'
      return
    }
    job.status = 'failed'
    job.error = publicError(error)
    const step = job.currentStep === null ? null : stepOf(job, job.currentStep)
    if (step !== null && (step.status === 'running' || step.status === 'pending')) {
      step.status = 'failed'
      step.detail = error instanceof Error ? error.message : String(error)
      if (step.detail.length > 160) step.detail = `${step.detail.slice(0, 157)}…`
    }
  }
  let draftMarkdown = ''
  try {
    job.status = 'running'
    job.updatedAt = Date.now()
    const course = await loadCourse(job.courseId)
    const outline = course.outline[job.index]
    if (outline === undefined) throw httpError('NOT_FOUND', '章节不存在')
    const dir = courseDir(job.courseId)
    const stem = chapterStem(job.index)

    setStep(job, 'plan', 'running')
    const plan = await generateChapterPlan(ctx, { course, outline, index: job.index, signal })
    setStep(job, 'plan', 'done', `${plan.sections.length} 个小节`)

    setStep(job, 'write', 'running')
    const bodyResult = await generateChapterBody(ctx, {
      course,
      outline,
      plan,
      index: job.index,
      signal,
      onSection: (current, total) => setStep(job, 'write', 'running', `${current}/${total} 个小节`),
    })
    let markdown = bodyResult.markdown
    draftMarkdown = markdown
    setStep(job, 'write', 'done', `${plan.sections.length} 个小节，约 ${markdown.length} 字`)

    setStep(job, 'concepts', 'running')
    let concepts = null
    try {
      concepts = await generateConcepts(ctx, { course, outline, markdown, index: job.index, signal })
      setStep(job, 'concepts', 'done', `${concepts.concepts.length} 个概念`)
    } catch (error) {
      concepts = null
      setStep(job, 'concepts', 'failed', error instanceof Error ? error.message : String(error))
      job.warnings.push('概念提取失败，已跳过')
    }

    setStep(job, 'quiz', 'running')
    let quiz = null
    const conceptNames = concepts === null ? [] : concepts.concepts.map((concept) => concept.name)
    try {
      quiz = await generateQuizWithRetry(ctx, { course, outline, markdown, concepts: conceptNames, signal })
      setStep(job, 'quiz', 'done', `${quiz.questions.length} 道题`)
    } catch (error) {
      quiz = null
      setStep(job, 'quiz', 'failed', error instanceof Error ? error.message : String(error))
      job.warnings.push('测验生成失败，本章暂缺测验')
    }

    setStep(job, 'validate', 'running')
    let report = validateChapter({ course, outline, index: job.index, markdown, quiz, concepts })
    if (report.hard.length === 0) {
      setStep(job, 'validate', 'done', '通过')
      setStep(job, 'repair', 'skipped', '无需修复')
    } else {
      setStep(job, 'validate', 'done', `${report.hard.length} 项需要修复`)
      setStep(job, 'repair', 'running')
      const repaired = await repairChapter(ctx, {
        course,
        outline,
        index: job.index,
        plan,
        markdown,
        quiz,
        concepts,
        report,
        signal,
        onProgress: (detail) => setStep(job, 'repair', 'running', detail),
      })
      markdown = repaired.markdown
      draftMarkdown = markdown
      if (repaired.quiz !== null) quiz = repaired.quiz
      if (repaired.concepts !== null) concepts = repaired.concepts
      report = validateChapter({ course, outline, index: job.index, markdown, quiz, concepts })
      if (repaired.fixed.length > 0) job.warnings.push(...repaired.fixed)
      if (report.hard.length > 0) {
        setStep(job, 'repair', 'failed', report.hard.map((item) => item.message).join('；').slice(0, 160))
      } else {
        setStep(job, 'repair', 'done', repaired.fixed.length > 0 ? repaired.fixed.join('；') : '已修复')
      }
    }
    if (report.warnings.length > 0) job.warnings.push(...report.warnings)
    if (report.hard.length > 0) {
      throw httpError('VALIDATION_FAILED', `章节未通过校验：${report.hard.map((item) => item.message).join('；')}`)
    }

    setStep(job, 'save', 'running')
    await mkdir(join(dir, 'chapters'), { recursive: true })
    await writeTextAtomic(join(dir, 'chapters', `${stem}.md`), markdown)
    if (quiz !== null) await writeJsonAtomic(join(dir, 'chapters', `${stem}.quiz.json`), quiz)
    if (concepts !== null) await writeJsonAtomic(join(dir, 'chapters', `${stem}.concepts.json`), concepts)
    const stored = await readJsonFile(join(dir, 'course.json'), null)
    if (stored !== null) {
      const generated = new Set(Array.isArray(stored.generated) ? stored.generated : [])
      generated.add(job.index)
      stored.generated = [...generated].sort((a, b) => a - b)
      stored.updatedAt = Date.now()
      if (stored.generated.length >= (stored.chapterCount ?? stored.outline?.length ?? 0)) stored.status = 'complete'
      else stored.status = 'generating'
      stored.model = routeOf(ctx)
      await writeJsonAtomic(join(dir, 'course.json'), stored)
    }
    try {
      await rebuildGraphForCourse(job.courseId)
    } catch (error) {
      ctx.logger?.warn?.(`learning-space: graph rebuild failed for ${job.courseId}: ${error?.message ?? error}`)
    }
    setStep(job, 'save', 'done')
    job.result = {
      chapter: {
        index: job.index,
        number: job.index + 1,
        title: outline.title,
        markdown,
        quiz,
        concepts,
      },
    }
    job.status = 'succeeded'
  } catch (error) {
    if (typeof draftMarkdown === 'string' && draftMarkdown !== '') job.draftMarkdown = draftMarkdown
    fail(error)
  } finally {
    clearTimeout(timeout)
    job.updatedAt = Date.now()
    const key = jobKey(job.courseId, job.index)
    if (activeChapterJobs.get(key) === job.id) activeChapterJobs.delete(key)
  }
}

async function apiDebug(ctx) {
  const route = routeOf(ctx)
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    maxTokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：你好' }] }],
  })
  const kinds = []
  const samples = {}
  let text = ''
  for await (const chunk of stream) {
    const type = chunk?.type ?? chunk?.kind ?? 'unknown'
    kinds.push(type)
    if (samples[type] === undefined) {
      const sample = {}
      for (const [key, value] of Object.entries(chunk ?? {})) {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          sample[key] = typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value
        } else {
          sample[key] = Array.isArray(value) ? `[array ${value.length}]` : typeof value
        }
      }
      samples[type] = sample
    }
    const delta = chunk?.text ?? chunk?.delta
    if (typeof delta === 'string') text += delta
  }
  return { route, kinds, samples, text }
}

/* ------------------------------------------------------------------ */
/* Model generation                                                    */
/* ------------------------------------------------------------------ */

function routeOf(ctx) {
  const selection = ctx.agentDefaultModel?.currentSelection?.()
  if (selection === null || selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw httpError('NO_MODEL', '未找到默认模型，请先在 Harness 设置里选择模型')
  }
  return { provider: selection.provider, model: selection.model }
}

let reasoningEffortCache = new Map()

/** Least reasoning effort advertised by the exact default route, or undefined. */
async function leastReasoningEffort(ctx, route) {
  const key = `${route.provider}/${route.model}`
  if (reasoningEffortCache.has(key)) return reasoningEffortCache.get(key)
  let effort
  try {
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
    effort = efforts.length > 0 && typeof efforts[0].id === 'string' ? efforts[0].id : undefined
  } catch {
    effort = undefined
  }
  reasoningEffortCache.set(key, effort)
  return effort
}

async function callModel(ctx, { system, prompt, maxTokens, signal }) {
  const route = routeOf(ctx)
  const effort = await leastReasoningEffort(ctx, route)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onOuterAbort, { once: true })
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      maxTokens,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      system,
      signal: controller.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    let text = ''
    let finish
    for await (const chunk of stream) {
      const type = chunk?.type ?? chunk?.kind
      if (type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text
        else if (typeof chunk.delta === 'string') text += chunk.delta
      } else if (type === 'finish') {
        finish = chunk.reason ?? chunk.finish
      }
    }
    if (finish !== undefined && (finish?.kind === 'error' || finish?.kind === 'aborted')) {
      throw httpError('MODEL_FAILED', finish?.failure?.message ?? '模型调用失败', {
        providerCode: finish?.failure?.code,
      })
    }
    if (text.trim() === '') {
      throw httpError('MODEL_FAILED', '模型返回了空内容，请重试', {
        finishKind: finish?.kind,
        reasoningTokens: finish?.kind === 'max-tokens' ? '可能耗尽了 maxTokens' : undefined,
      })
    }
    return text
  } catch (error) {
    if (error?.name === 'AbortError') throw httpError('MODEL_FAILED', '模型调用超时或被取消，请重试')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onOuterAbort)
  }
}

function extractJson(text) {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const body = fenced === null ? trimmed : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) throw httpError('PARSE_FAILED', '模型输出里找不到 JSON')
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    throw httpError('PARSE_FAILED', '模型输出的 JSON 无法解析，请重试')
  }
}

async function generateOutline(ctx, { topic, domain, level, chapterCount, notes }) {
  const system = [
    '你是一位资深学习设计师，擅长把任意主题设计成从基础到进阶的课程大纲。',
    '只输出单个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。',
  ].join('\n')
  const prompt = [
    `主题：${topic}`,
    `领域风格：${DOMAINS[domain]}`,
    `难度：${LEVELS[level]}`,
    `章节数量：${chapterCount}`,
    notes === '' ? '' : `补充要求：${notes}`,
    '',
    '要求：',
    `1. 严格输出 ${chapterCount} 章，从基础到进阶，前后逻辑连贯，避免重复。`,
    '2. 每章给出 title（不超过 20 字）、summary（一句话说明本章解决什么问题）、durationMinutes（10-60 的整数）、concepts（2-5 个核心概念）。',
    '3. 标题要具体，不要只写「绪论」「概述」「总结」这类空泛标题。',
    `4. 内容风格：${DOMAIN_STYLE[domain]}`,
    '5. 只输出 JSON，格式：',
    '{"title":"课程标题（不超过 24 字）","chapters":[{"title":"章节标题","summary":"本章目标","durationMinutes":20,"concepts":["概念1","概念2"]}]}',
  ]
    .filter((line) => line !== '')
    .join('\n')

  const raw = await callModel(ctx, { system, prompt, maxTokens: 4500 })
  const parsed = extractJson(raw)
  const title = typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim().slice(0, 60) : topic
  const rawChapters = Array.isArray(parsed.chapters) ? parsed.chapters : []
  const chapters = []
  for (const item of rawChapters) {
    if (item === null || typeof item !== 'object') continue
    const chapterTitle = typeof item.title === 'string' ? item.title.trim() : ''
    if (chapterTitle === '') continue
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    const duration = Number(item.durationMinutes)
    const concepts = Array.isArray(item.concepts)
      ? item.concepts.filter((concept) => typeof concept === 'string' && concept.trim() !== '').map((concept) => concept.trim()).slice(0, 6)
      : []
    chapters.push({
      title: chapterTitle.slice(0, 60),
      summary: summary === '' ? chapterTitle : summary.slice(0, 160),
      durationMinutes: Number.isFinite(duration) ? Math.min(90, Math.max(10, Math.round(duration))) : 20,
      concepts,
    })
  }
  if (chapters.length === 0) throw httpError('PARSE_FAILED', '模型没有返回可用的章节大纲，请重试')
  return { title, chapters: chapters.slice(0, 12) }
}

/* ------------------------------------------------------------------ */
/* Multi-step chapter pipeline: plan -> sections -> concepts -> quiz   */
/* -> validate -> repair -> save                                       */
/* ------------------------------------------------------------------ */

const CODE_ALLOWED_DOMAINS = new Set(['technical', 'general'])
const SVG_REQUIRED_DOMAINS = new Set(['engineering', 'humanities'])
const MERMAID_DOMAINS = new Set(['technical', 'engineering', 'general'])

function normalizeSectionTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, 40) : ''
}

function normalizeElements(value) {
  if (!Array.isArray(value)) return []
  const elements = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const key = item.trim().toLowerCase()
    if (SECTION_ELEMENTS.has(key) && !elements.includes(key)) elements.push(key)
  }
  return elements
}

function synthesizePlan(course, outline) {
  const concepts = Array.isArray(outline.concepts) ? outline.concepts.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  const first = concepts[0] ?? outline.title
  const second = concepts[1] ?? '核心原理'
  const sections = [
    {
      title: '核心概念与直觉',
      goal: `建立对「${first}」的直觉`,
      keyPoints: concepts.slice(0, 3),
      elements: ['mermaid'],
    },
    {
      title: '原理拆解',
      goal: `讲清「${second}」的原理与关键步骤`,
      keyPoints: concepts.slice(1, 4),
      elements: SVG_REQUIRED_DOMAINS.has(course.domain) ? ['svg'] : ['table'],
    },
    {
      title: '应用与对比',
      goal: '用具体例子说明如何应用，并对比不同做法',
      keyPoints: [],
      elements: ['table'],
    },
  ]
  const summaryPoints = [
    `理解 ${first} 的核心含义与适用场景。`,
    `掌握 ${second} 的关键步骤与常见误区。`,
    '能够在实际问题中判断何时使用这些方法。',
  ]
  return { sections, summaryPoints, nextPreview: '' }
}

function ensurePlanCoverage(plan, course, outline, index) {
  let sections = Array.isArray(plan.sections) ? plan.sections : []
  sections = sections
    .filter((section) => section !== null && typeof section === 'object' && normalizeSectionTitle(section.title) !== '')
    .slice(0, 5)
    .map((section) => ({
      title: normalizeSectionTitle(section.title),
      goal: typeof section.goal === 'string' ? section.goal.trim().slice(0, 120) : '',
      keyPoints: Array.isArray(section.keyPoints)
        ? section.keyPoints.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, 4)
        : [],
      elements: normalizeElements(section.elements),
    }))
  if (sections.length < 2) return synthesizePlan(course, outline)

  if (!CODE_ALLOWED_DOMAINS.has(course.domain)) {
    for (const section of sections) section.elements = section.elements.filter((element) => element !== 'code')
  }
  const has = (element) => sections.some((section) => section.elements.includes(element))
  if (!has('table')) sections[Math.max(0, sections.length - 2)].elements.push('table')
  if (MERMAID_DOMAINS.has(course.domain) && !has('mermaid')) sections[0].elements.push('mermaid')
  if (SVG_REQUIRED_DOMAINS.has(course.domain) && !has('svg')) sections[Math.min(1, sections.length - 1)].elements.push('svg')

  const rawSummary = Array.isArray(plan.summaryPoints) ? plan.summaryPoints : []
  const summaryPoints = rawSummary
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().slice(0, 120))
    .slice(0, 5)
  if (summaryPoints.length < 3) {
    const concepts = Array.isArray(outline.concepts) ? outline.concepts : []
    const fallback = [
      `本章理解了「${concepts[0] ?? outline.title}」的核心含义。`,
      '掌握了关键原理、操作步骤与常见误区。',
      '能够结合具体场景判断如何应用。',
    ]
    while (summaryPoints.length < 3) summaryPoints.push(fallback[summaryPoints.length] ?? '本章内容已完整串联。')
  }
  const nextPreview = typeof plan.nextPreview === 'string' ? plan.nextPreview.trim().slice(0, 120) : ''
  return { sections, summaryPoints, nextPreview }
}

async function generateChapterPlan(ctx, { course, outline, index, signal }) {
  const system = [
    '你是一位资深学习内容设计师。你只输出单个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。',
  ].join('\n')
  const previous = index > 0 ? course.outline[index - 1] : null
  const next = index + 1 < course.outline.length ? course.outline[index + 1] : null
  const prompt = [
    `课程：《${course.title}》（${DOMAINS[course.domain] ?? '通用通识'}，${LEVELS[course.level] ?? '入门'}）`,
    `第 ${index + 1} 章《${outline.title}》，本章目标：${outline.summary}`,
    `核心概念：${(Array.isArray(outline.concepts) ? outline.concepts : []).join('、') || '（见标题）'}`,
    previous === null ? '这是第一章。' : `上一章：${previous.title}`,
    next === null ? '这是最后一章。' : `下一章：${next.title}`,
    '',
    '请规划本章的写作结构：',
    '1. sections：3-5 个内容小节（不含本章小结/下一章预告）。每个小节给出 title（≤18 字）、goal（一句话）、keyPoints（2-4 个要点）、elements（从 table/mermaid/code/svg/callout 中选，可为空数组）。',
    '2. 元素覆盖要求：',
    '   - 所有课程至少 1 个小节含 table（对比表格）。',
    '   - technical/engineering/general 至少 1 个小节含 mermaid（只画关系/流程，不画实物）。',
    '   - engineering/humanities 恰好 1 个小节含 svg（内联实物/场景示意图）。',
    '   - 只有 technical/general 可以使用 code；engineering/humanities 禁止 code。',
    '3. summaryPoints：3-5 条本章小结（每句≤40 字）。',
    '4. nextPreview：非最后一章写给下一章的预告；最后一章写结课回顾。≤80 字。',
    '只输出 JSON，格式：',
    '{"sections":[{"title":"小节标题","goal":"这一节解决什么","keyPoints":["要点1","要点2"],"elements":["table"]}],"summaryPoints":["小结1","小结2","小结3"],"nextPreview":"……"}',
  ].join('\n')
  let parsed = null
  try {
    const raw = await callModel(ctx, { system, prompt, maxTokens: 2200, signal })
    parsed = extractJson(raw)
  } catch (error) {
    ctx.logger?.warn?.(`learning-space: chapter plan failed, using fallback plan: ${error?.message ?? error}`)
    parsed = null
  }
  return ensurePlanCoverage(parsed ?? {}, course, outline, index)
}

function normalizeFenceMarkers(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let open = false
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```')) {
      const info = trimmed.slice(3).trim()
      if (!open) {
        open = true
        out.push(info === '' ? '```' : `\`\`\`${info}`)
      } else {
        open = false
        out.push('```')
      }
    } else {
      out.push(line)
    }
  }
  if (open) out.push('```')
  return out.join('\n')
}

function normalizeSectionMarkdown(raw, title) {
  let text = String(raw ?? '').trim()
  if (/^```(?:markdown|md)?\s*\r?\n/i.test(text) && /\r?\n```\s*$/.test(text)) {
    text = text.replace(/^```(?:markdown|md)?\s*\r?\n/i, '').replace(/\r?\n```\s*$/, '').trim()
  }
  text = text.replace(/^#\s+[^\n]*\n+/, '')
  text = normalizeFenceMarkers(text)
  if (!/^##\s+/m.test(text)) text = `## ${title}\n\n${text}`
  return text.trim()
}

async function generateChapterSection(ctx, { course, outline, plan, index, section, position, total, previousTail, signal }) {
  const system = [
    '你是一位学习内容作者。只输出当前这一小节的 Markdown，从 `## 小节标题` 开始。',
    '不要输出一级标题、本章小结、下一章预告、测验或任何解释文字；不要用代码围栏包裹整节内容。',
  ].join('\n')
  const planText = plan.sections.map((item, itemIndex) => `${itemIndex + 1}. ${item.title} —— ${item.goal}`).join('\n')
  const elementHints = []
  if (section.elements.includes('table')) elementHints.push('table：至少一个 Markdown 对比表格')
  if (section.elements.includes('mermaid')) elementHints.push('mermaid：至少一个 ```mermaid 图（flowchart TD / sequenceDiagram），只画关系/流程，不画实物')
  if (section.elements.includes('code')) elementHints.push('code：一个标注语言的代码块（如 ```python），并用一两句话解释')
  if (section.elements.includes('svg'))
    elementHints.push(
      'svg：一个内联 <svg viewBox="0 0 680 400" ...>...</svg> 示意图（直接写在正文中，不要放进代码围栏）。全部样式内联（禁止 <style>/class/CSS 变量/外部字体或图片）；浅底 #ffffff/#f8fafc，文字 #1f2937；线宽 1.5-2，字号 11-15px；中文标注、所有文字落在 viewBox 内且不重叠',
    )
  if (section.elements.includes('callout')) elementHints.push('callout：可用 > [!tip]/[!warning]/[!concept]/[!question] 提示框')
  const prompt = [
    `课程：《${course.title}》（${DOMAINS[course.domain] ?? '通用通识'}，${LEVELS[course.level] ?? '入门'}）`,
    `第 ${index + 1} 章《${outline.title}》，本章目标：${outline.summary}`,
    `核心概念：${(Array.isArray(outline.concepts) ? outline.concepts : []).join('、') || '（见标题）'}`,
    '',
    '本章小节规划：',
    planText,
    previousTail === '' ? '' : `已写上一节结尾（用于衔接，不要重复）：\n${previousTail}`,
    '',
    `当前小节：第 ${position}/${total} 节`,
    `标题：${section.title}`,
    `目标：${section.goal}`,
    section.keyPoints.length > 0 ? `要点：${section.keyPoints.join('、')}` : '',
    elementHints.length > 0 ? `本节需要包含：${elementHints.join('；')}` : '',
    '',
    '写作要求：',
    '1. 300-700 字；先用一个真实生活类比引入，再解释原理，最后一句给出结论。',
    '2. 只写这一节，不要写其它小节的内容，不要写本章小结/预告/测验。',
    '3. 只用 Markdown 语法；除 svg 元素要求外不要使用其它 HTML。',
    '4. 概念关系、流程、时序优先用 mermaid；不要用 mermaid 画实物。',
    ...(CODE_ALLOWED_DOMAINS.has(course.domain)
      ? []
      : ['5. 本课程是工程/人文方向，禁止输出任何编程代码块（包括伪代码）；用文字、表格、mermaid 或 SVG 表达。']),
  ]
    .filter((line) => line !== '')
    .join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 3000, signal })
  return normalizeSectionMarkdown(raw, section.title)
}

async function generateChapterBody(ctx, { course, outline, plan, index, signal, onSection }) {
  const number = index + 1
  const header = [
    `# 第 ${number} 章 ${outline.title}`,
    '',
    `> 预计阅读时间：${outline.durationMinutes ?? 20} 分钟`,
    '>',
    `> 本章目标：${outline.summary}`,
  ].join('\n')
  const parts = [header]
  let previousTail = ''
  for (let position = 0; position < plan.sections.length; position += 1) {
    if (onSection !== undefined) onSection(position + 1, plan.sections.length)
    const section = plan.sections[position]
    const text = await generateChapterSection(ctx, {
      course,
      outline,
      plan,
      index,
      section,
      position: position + 1,
      total: plan.sections.length,
      previousTail,
      signal,
    })
    if (text.trim() === '') throw httpError('PARSE_FAILED', `第 ${position + 1} 小节没有内容，请重试`)
    parts.push(text)
    previousTail = text.slice(-600)
  }
  const summary = `## 本章小结\n\n${plan.summaryPoints.map((point) => `- ${point}`).join('\n')}`
  const last = index + 1 >= course.outline.length
  const closingTitle = last ? '## 结课回顾' : '## 下一章预告'
  const nextTitle = last ? '' : course.outline[index + 1]?.title ?? ''
  const closingText =
    plan.nextPreview !== ''
      ? plan.nextPreview
      : last
        ? '本课程到这里结束。建议回看知识图谱，并按复习计划再过一遍薄弱章节。'
        : `下一章将进入《${nextTitle}》，继续把本章的方法用起来。`
  parts.push(summary, `${closingTitle}\n\n${closingText}`)
  const assembled = normalizeFenceMarkers(parts.join('\n\n').trim())
  return { markdown: `${assembled}\n`, sections: plan.sections }
}

async function generateConcepts(ctx, { course, outline, markdown, index, signal }) {
  const system = [
    '你是一位知识工程师。你只输出单个 JSON 对象，不要 Markdown 代码围栏，不要解释文字。',
  ].join('\n')
  const prompt = [
    `课程：《${course.title}》`,
    `第 ${index + 1} 章《${outline.title}》`,
    `大纲概念：${(Array.isArray(outline.concepts) ? outline.concepts : []).join('、') || '（见正文）'}`,
    '',
    '本章正文节选：',
    markdown.slice(0, 7000),
    '',
    '请从本章提取 3-8 个核心概念，输出 JSON：',
    '{"concepts":[{"name":"概念名（≤20字，优先复用大纲概念）","definition":"一句话解释","prerequisites":["前置概念名"],"difficulty":1}]}',
    '要求：',
    '1. name 不得重复；prerequisites 只能引用本列表内的概念名，可以为空数组。',
    '2. difficulty 为 1-5 的整数，表示理解难度。',
    '3. 只输出 JSON。',
  ].join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 2200, signal })
  const parsed = extractJson(raw)
  const rawConcepts = Array.isArray(parsed.concepts) ? parsed.concepts : []
  const concepts = []
  for (const item of rawConcepts) {
    if (item === null || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 30) : ''
    if (name === '' || concepts.some((concept) => concept.name === name)) continue
    const definition = typeof item.definition === 'string' ? item.definition.trim().slice(0, 160) : ''
    const prerequisites = Array.isArray(item.prerequisites)
      ? item.prerequisites.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()).slice(0, 6)
      : []
    const difficulty = Math.min(5, Math.max(1, Math.round(Number(item.difficulty) || 2)))
    concepts.push({ name, definition, prerequisites, difficulty })
    if (concepts.length >= 8) break
  }
  const known = new Set(concepts.map((concept) => concept.name))
  for (const concept of concepts) concept.prerequisites = concept.prerequisites.filter((name) => known.has(name) && name !== concept.name)
  if (concepts.length === 0) throw httpError('PARSE_FAILED', '概念提取失败，请重试')
  return { chapterIndex: index, concepts, generatedAt: Date.now(), model: routeOf(ctx) }
}

function quizIssues(quiz) {
  if (quiz === null || quiz === undefined || typeof quiz !== 'object' || !Array.isArray(quiz.questions)) {
    return ['缺少测验题']
  }
  const questions = quiz.questions
  if (questions.length < 3) return ['测验题少于 3 道']
  const issues = []
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    if (question === null || typeof question !== 'object') {
      issues.push(`第 ${index + 1} 题格式不正确`)
      continue
    }
    if (typeof question.question !== 'string' || question.question.trim() === '') issues.push(`第 ${index + 1} 题缺少题干`)
    if (!Array.isArray(question.options) || question.options.length !== 4) issues.push(`第 ${index + 1} 题选项不是 4 个`)
    if (!Number.isInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex > 3) {
      issues.push(`第 ${index + 1} 题缺少有效答案`)
    }
    if (typeof question.explanation !== 'string' || question.explanation.trim() === '') issues.push(`第 ${index + 1} 题缺少解析`)
  }
  return issues
}

async function generateQuizWithRetry(ctx, { course, outline, markdown, concepts, signal }) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const quiz = await generateQuiz(ctx, { course, outline, markdown, concepts, signal })
      if (quizIssues(quiz).length === 0) return quiz
      lastError = httpError('PARSE_FAILED', `测验不合格：${quizIssues(quiz)[0]}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? httpError('PARSE_FAILED', '测验生成失败，请重试')
}

function validateChapter({ course, outline, index, markdown, quiz, concepts }) {
  const hard = []
  const warnings = []
  const text = String(markdown ?? '')
  const number = index + 1
  if (!new RegExp(`^#\\s*第\\s*${number}\\s*章`, 'm').test(text)) hard.push({ code: 'title', message: '缺少章节一级标题' })
  if (!/^>\s*预计阅读时间/m.test(text)) warnings.push('缺少预计阅读时间引用块')
  const h2Count = (text.match(/^##\s+/gm) ?? []).length
  if (h2Count < 3) hard.push({ code: 'structure', message: '二级小节数量不足' })
  if (!/^##\s*本章小结/m.test(text)) hard.push({ code: 'summary', message: '缺少本章小结' })
  if (!/(?:^|\n)\|[^\n]*\|[^\n]*\n\|?[\s:|-]+\|/.test(text)) hard.push({ code: 'table', message: '缺少对比表格' })
  const fenceInfos = listFenceInfos(text)
  const fenceLanguages = fenceInfos.map((info) => info.split(/\s+/)[0].toLowerCase()).filter((language) => language !== '')
  const codeFences = fenceLanguages.filter((language) => language !== 'mermaid' && language !== 'svg')
  if (codeFences.length > 0 && !CODE_ALLOWED_DOMAINS.has(course.domain)) {
    hard.push({ code: 'engineering-code', message: '工程/人文课程不应出现编程代码块' })
  }
  if (fenceInfos.some((info) => info === '')) hard.push({ code: 'code-language', message: '存在未标注语言的代码块' })
  if (MERMAID_DOMAINS.has(course.domain) && !fenceLanguages.includes('mermaid')) {
    warnings.push('没有 Mermaid 关系图')
  }
  const svgs = [...text.matchAll(/<svg[\s\S]*?<\/svg>/gi)]
  if (SVG_REQUIRED_DOMAINS.has(course.domain) && svgs.length === 0) {
    hard.push({ code: 'svg', message: '工程/人文章节缺少内联 SVG 示意图' })
  }
  for (const match of svgs) {
    if (!isSafeSvgFragment(match[0])) {
      hard.push({ code: 'svg-unsafe', message: 'SVG 含有不允许的内容（脚本/事件/外链等）' })
      break
    }
  }
  const problems = quizIssues(quiz)
  if (quiz === null) warnings.push('本章暂无测验')
  else if (problems.length > 0) hard.push({ code: 'quiz', message: `测验不合格：${problems[0]}` })
  if (concepts === null || concepts === undefined || !Array.isArray(concepts.concepts) || concepts.concepts.length < 3) {
    warnings.push('核心概念不足 3 个')
  }
  if (text.length < 900) warnings.push('章节偏短（不足 900 字）')
  return { hard, warnings }
}

function listFenceInfos(markdown) {
  const infos = []
  let open = false
  for (const line of String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('```')) continue
    if (!open) {
      open = true
      infos.push(trimmed.slice(3).trim())
    } else {
      open = false
    }
  }
  if (open) infos.push('')
  return infos
}

function addMissingFenceLanguages(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let open = false
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('```')) {
      out.push(line)
      continue
    }
    const info = trimmed.slice(3).trim()
    if (!open) {
      open = true
      out.push(info === '' ? '```text' : `\`\`\`${info}`)
    } else {
      open = false
      out.push('```')
    }
  }
  return out.join('\n')
}

function insertBeforeSummary(markdown, block) {
  const index = markdown.search(/^##\s*本章小结/m)
  if (index >= 0) return `${markdown.slice(0, index)}${block}\n\n${markdown.slice(index)}`
  return `${markdown.trimEnd()}\n\n${block}\n`
}

function stripFencesToQuotes(markdown) {
  return markdown.replace(/```[^\n]*\r?\n([\s\S]*?)```/g, (match, code) => {
    const lines = String(code)
      .trim()
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
    return `> 工艺说明\n>\n${lines.join('\n')}`
  })
}

function stripProgrammingFences(markdown) {
  return String(markdown).replace(/```([^\n`]*)\r?\n([\s\S]*?)```/g, (match, info, code) => {
    const language = String(info ?? '').trim().split(/\s+/)[0].toLowerCase()
    if (language === 'mermaid' || language === 'svg') return match
    const lines = String(code)
      .replace(/\s+$/, '')
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
    if (lines.length === 0 || lines.every((line) => line.trim() === '>')) return ''
    return `> 工艺说明\n>\n${lines.join('\n')}`
  })
}

async function repairEngineeringCode(ctx, { course, outline, markdown, signal }) {
  const system = [
    '你是工科课程编辑。工科课程不应该出现编程代码块。只输出 JSON，不要解释。',
  ].join('\n')
  const prompt = [
    `课程：《${course.title}》`,
    `章节：《${outline.title}》`,
    '请把下面章节里的每个代码块改写为 1-2 句中文工艺/参数说明，保持上下文连贯，不要引入新的代码。',
    '只输出 JSON：{"replacements":[{"index":0,"text":"替换说明"}]}，index 按代码块出现顺序从 0 开始。',
    '',
    '章节内容：',
    markdown.slice(0, 8000),
  ].join('\n')
  try {
    const raw = await callModel(ctx, { system, prompt, maxTokens: 1600, signal })
    const parsed = extractJson(raw)
    const replacements = Array.isArray(parsed.replacements) ? parsed.replacements : []
    let cursor = 0
    let replaced = 0
    const result = markdown.replace(/```[^\n]*\r?\n([\s\S]*?)```/g, (match) => {
      const item = replacements.find((entry) => entry !== null && typeof entry === 'object' && Number(entry.index) === cursor)
      cursor += 1
      const replacement = item !== undefined && typeof item.text === 'string' && item.text.trim() !== '' ? item.text.trim() : ''
      if (replacement === '') return match
      replaced += 1
      return replacement
    })
    if (replaced === 0) return { markdown: stripProgrammingFences(markdown), notes: ['工科代码块已降级为引用说明'] }
    const cleaned = stripProgrammingFences(result)
    return { markdown: cleaned, notes: [`工科代码块已改写 ${replaced} 处`] }
  } catch {
    return { markdown: stripProgrammingFences(markdown), notes: ['工科代码块已降级为引用说明'] }
  }
}

async function generateComparisonTable(ctx, { course, outline, markdown, signal }) {
  const system = ['你只输出一个 Markdown 对比表格，不要表头以外的解释文字。'].join('\n')
  const prompt = [
    `课程：《${course.title}》`,
    `章节：《${outline.title}》`,
    '请基于下面章节内容，输出一个 3 列以上、至少 2 行数据的中文对比表格（表头不能为空）。',
    '',
    '章节内容节选：',
    markdown.slice(0, 2500),
  ].join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 800, signal })
  const lines = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
  if (lines.length < 3) throw httpError('PARSE_FAILED', '对比表格生成失败')
  return lines.join('\n')
}

async function repairChapter(ctx, { course, outline, index, plan, markdown, quiz, concepts, report, signal, onProgress }) {
  const codes = new Set(report.hard.map((item) => item.code))
  const fixed = []
  let text = markdown
  let nextQuiz = quiz
  let nextConcepts = concepts

  if (codes.has('svg-unsafe')) {
    if (onProgress) onProgress('移除不安全的 SVG')
    text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '')
    codes.add('svg')
    fixed.push('移除不安全的 SVG')
  }
  if (codes.has('svg')) {
    if (onProgress) onProgress('补充内联示意图')
    try {
      const illustration = await generateSvgIllustration(ctx, { course, outline, markdown: text, signal })
      text = appendIllustration(text, illustration)
      fixed.push('已补充内联 SVG 示意图')
    } catch {
      fixed.push('SVG 补图失败')
    }
  }
  if (codes.has('engineering-code')) {
    if (onProgress) onProgress('改写工科代码块')
    const repaired = await repairEngineeringCode(ctx, { course, outline, markdown: text, signal })
    text = repaired.markdown
    fixed.push(...repaired.notes)
  }
  if (codes.has('code-language')) {
    text = addMissingFenceLanguages(text)
    fixed.push('为代码块补充语言标记')
  }
  if (codes.has('table')) {
    if (onProgress) onProgress('补充对比表格')
    try {
      const table = await generateComparisonTable(ctx, { course, outline, markdown: text, signal })
      text = insertBeforeSummary(text, `## 对比总结\n\n${table}`)
      fixed.push('已补充对比表格')
    } catch {
      fixed.push('对比表格补充失败')
    }
  }
  if (codes.has('summary')) {
    const summary = `## 本章小结\n\n${plan.summaryPoints.map((point) => `- ${point}`).join('\n')}`
    text = `${text.trimEnd()}\n\n${summary}\n`
    fixed.push('已补充本章小结')
  }
  if (codes.has('title')) {
    text = `# 第 ${index + 1} 章 ${outline.title}\n\n${text}`
    fixed.push('已补充章节标题')
  }
  if (codes.has('quiz')) {
    if (onProgress) onProgress('重新生成测验')
    try {
      nextQuiz = await generateQuizWithRetry(ctx, {
        course,
        outline,
        markdown: text,
        concepts: nextConcepts === null || nextConcepts === undefined ? [] : nextConcepts.concepts.map((concept) => concept.name),
        signal,
      })
      fixed.push('已重新生成测验')
    } catch {
      fixed.push('测验重新生成失败')
    }
  }
  return { markdown: text, quiz: nextQuiz, concepts: nextConcepts, fixed }
}

/* ------------------------------------------------------------------ */
/* Inline SVG illustration (engineering / humanities)                  */
/* ------------------------------------------------------------------ */

function extractSvgFragment(text) {
  const cleaned = String(text)
    .replace(/```[a-zA-Z0-9_-]*\r?\n?/g, '')
    .replace(/```/g, '')
  const match = /<svg[\s\S]*?<\/svg>/i.exec(cleaned)
  return match === null ? null : match[0].trim()
}

function isSafeSvgFragment(svg) {
  if (typeof svg !== 'string' || svg.length < 80 || svg.length > 60000) return false
  if (!/^<svg[\s>]/i.test(svg)) return false
  if (!/viewBox\s*=\s*["'][^"']+["']/i.test(svg)) return false
  if (/<script|<style|<foreignObject|<iframe|<image\b|<a\s/i.test(svg)) return false
  if (/\son[a-z]+\s*=/i.test(svg)) return false
  if (/javascript:/i.test(svg)) return false
  if (/(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(svg)) return false
  return true
}

function appendIllustration(markdown, svg) {
  const block = `\n\n## 本章图解\n\n${svg}\n\n`
  const markerIndex = markdown.search(/^##\s*本章小结/m)
  if (markerIndex >= 0) return `${markdown.slice(0, markerIndex)}${block}${markdown.slice(markerIndex)}`
  return `${markdown.trimEnd()}${block}`
}

async function generateSvgIllustration(ctx, { course, outline, markdown, signal }) {
  const system =
    '你是一位擅长用纯内联 SVG 绘制示意图的工程与科普插画师。只输出一个完整的 <svg>...</svg> 片段，不要解释，不要 Markdown 代码围栏，不要输出任何其它文字。'
  const prompt = [
    `课程：《${course.title}》（${DOMAINS[course.domain] ?? '通用通识'}，${LEVELS[course.level] ?? '入门'}）`,
    `本章标题：${outline.title}`,
    `本章目标：${outline.summary}`,
    `核心概念：${(Array.isArray(outline.concepts) ? outline.concepts : []).join('、') || '（见正文）'}`,
    '',
    '本章正文节选：',
    markdown.slice(0, 2600),
    '',
    '请为本章绘制 1 张帮助理解的示意图：',
    course.domain === 'humanities'
      ? '画面要求：作品场景 / 空间布局 / 时间线或人物关系，带中文标注。'
      : '画面要求：真实设备剖面 / 工艺流程 / 管线与流向 / 产线布局，带中文标注与箭头，突出关键部件与参数。',
    '通用规范：',
    '1. 只输出 <svg viewBox="0 0 680 400" xmlns="http://www.w3.org/2000/svg">…</svg>，不要 <?xml?>、doctype 或解释文字。',
    '2. 全部样式内联（fill、stroke、stroke-width、font-size、font-family 等）；禁止 <style>、class、CSS 变量、外部字体/图片、<script>、<foreignObject>、事件属性、javascript: 链接。',
    '3. 浅色底卡（#ffffff 或 #f8fafc），文字 #1f2937，线宽 1.5-2，字号 11-15px。',
    '4. 构图清晰、留白合理，所有文字落在 viewBox 内且互不重叠；中文标注简短。',
  ].join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 4500, signal })
  const svg = extractSvgFragment(raw)
  if (svg === null || !isSafeSvgFragment(svg)) {
    throw httpError('PARSE_FAILED', '模型没有返回可用的 SVG 示意图')
  }
  return svg
}

async function generateQuiz(ctx, { course, outline, markdown, concepts, signal }) {
  const conceptNames = Array.isArray(concepts)
    ? [...new Set(concepts.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim()))]
    : []
  const system = [
    '你是一位出题老师，负责为学习材料出单选题。',
    '只输出单个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。',
  ].join('\n')
  const prompt = [
    `课程：《${course.title}》`,
    `章节：${outline.title}`,
    conceptNames.length > 0 ? `本章核心概念：${conceptNames.join('、')}` : '',
    '',
    '以下是章节正文：',
    markdown.slice(0, 12000),
    '',
    '要求：',
    '1. 出 3 道中文单选题，考察理解与应用，而不是死记硬背。',
    '2. 每题 4 个选项，只有一个正确答案，干扰项要合理且互不重复。',
    '3. 不要使用「以上都对」「以上都不对」这类选项。',
    '4. 每题给出 explanation，说明正确选项为什么对、错误选项为什么错。',
    conceptNames.length > 0
      ? '5. 每题必须绑定 1-2 个考察的概念，概念名逐字复用上面「本章核心概念」中的名称，放在 concepts 数组里。'
      : '',
    '6. 只输出 JSON，格式：',
    conceptNames.length > 0
      ? '{"questions":[{"question":"题干","options":["选项A","选项B","选项C","选项D"],"answerIndex":0,"explanation":"解析","concepts":["概念名"]}]}'
      : '{"questions":[{"question":"题干","options":["选项A","选项B","选项C","选项D"],"answerIndex":0,"explanation":"解析"}]}',
  ]
    .filter((line) => line !== '')
    .join('\n')
  const raw = await callModel(ctx, { system, prompt, maxTokens: 2800, signal })
  const parsed = extractJson(raw)
  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : []
  const questions = []
  const knownConcepts = new Set(conceptNames)
  for (const item of rawQuestions) {
    if (item === null || typeof item !== 'object') continue
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    const options = Array.isArray(item.options)
      ? item.options.filter((option) => typeof option === 'string' && option.trim() !== '').map((option) => option.trim()).slice(0, 4)
      : []
    const answerIndex = Number(item.answerIndex)
    const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : ''
    if (question === '' || options.length !== 4) continue
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) continue
    let bound = Array.isArray(item.concepts)
      ? item.concepts
          .filter((name) => typeof name === 'string' && name.trim() !== '')
          .map((name) => name.trim())
          .filter((name) => knownConcepts.size === 0 || knownConcepts.has(name))
      : []
    if (bound.length === 0 && conceptNames.length > 0) {
      const haystack = `${question} ${options.join(' ')}`
      bound = conceptNames.filter((name) => haystack.includes(name)).slice(0, 2)
    }
    if (bound.length === 0 && conceptNames.length > 0) bound = conceptNames.slice(0, 2)
    questions.push({ question, options, answerIndex, explanation, concepts: [...new Set(bound)] })
    if (questions.length >= 5) break
  }
  if (questions.length === 0) throw httpError('PARSE_FAILED', '模型没有返回可用的测验题')
  return { questions }
}
