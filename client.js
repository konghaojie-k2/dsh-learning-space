/**
 * Client half of the learning-space bundle.
 *
 * Renders the sidebar panel icon plus the full-page "学习空间" view:
 * course list, AI outline creation, serial chapter generation, Markdown
 * chapter reader with KaTeX math, knowledge graph, spaced-repetition review,
 * chapter-end quizzes, and progress synced back to course.json.
 *
 * Only React (`require('react')`) is used. All colors come from host theme
 * tokens; no third-party code, no host DOM access. KaTeX assets are injected
 * once by `apply()` and removed on disposal.
 */

window.__ModuleLoader__.load({
  id: '@local/learning-space',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ---------------------------------------------------------------- */
    /* Constants                                                         */
    /* ---------------------------------------------------------------- */

    const API_PATH = '/learning-space/api';
    const PLAN_LABELS = { unlock: '解锁', review: '复习', mastery: '补强', generate: '生成', retrain: '订正' };
    const PROGRESS_KEY = 'dsh.learning-space.progress.v1';
    const LAST_KEY = 'dsh.learning-space.last.v1';

    const KATEX_CSS_HREF = '/learning-space/vendor/katex/katex.min.css';
    const KATEX_JS_SRC = '/learning-space/vendor/katex/katex.min.js';
    const KATEX_READY_EVENT = 'learning-space:katex-ready';
    const KATEX_FAILED_EVENT = 'learning-space:katex-failed';
    const PRISM_JS_SRC = '/learning-space/vendor/prism/prism-bundle.min.js';
    const PRISM_READY_EVENT = 'learning-space:prism-ready';
    const PRISM_FAILED_EVENT = 'learning-space:prism-failed';
    const MERMAID_JS_SRC = '/learning-space/vendor/mermaid/mermaid.min.js';
    const MERMAID_READY_EVENT = 'learning-space:mermaid-ready';
    const VENDOR_ATTR = 'data-learning-space';


    const MIN_CHAPTERS = 3;
    const MAX_CHAPTERS = 12;
    const DEFAULT_CHAPTERS = 6;
    const MAX_NOTES = 500;

    const DAY_MS = 24 * 60 * 60 * 1000;
    const REVIEW_INTERVALS = [1, 3, 7, 14, 30];
    const PROGRESS_SYNC_DELAY_MS = 450;
    const PROGRESS_SYNC_RETRY_MS = 1500;

    const GRAPH_HIGHLIGHT_RELATIONS = { prerequisite: '前置', related: '相关', contrast: '对比' };


    const DOMAIN_OPTIONS = [
      { value: 'general', label: '通用通识' },
      { value: 'technical', label: '技术编程' },
      { value: 'engineering', label: '工科工程' },
      { value: 'humanities', label: '人文艺术' },
    ];
    const LEVEL_OPTIONS = [
      { value: 'beginner', label: '入门' },
      { value: 'intermediate', label: '进阶' },
      { value: 'advanced', label: '深入' },
    ];
    const DOMAIN_LABELS = Object.fromEntries(DOMAIN_OPTIONS.map((item) => [item.value, item.label]));
    const LEVEL_LABELS = Object.fromEntries(LEVEL_OPTIONS.map((item) => [item.value, item.label]));

    /* ---------------------------------------------------------------- */
    /* Small utilities                                                   */
    /* ---------------------------------------------------------------- */

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function sameDay(a, b) {
      return (
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
      );
    }

    /** Relative time in Chinese: 刚刚 / N 分钟前 / 今天 HH:mm / 日期. */
    function formatRelativeTime(timestamp) {
      const value = Number(timestamp);
      if (!Number.isFinite(value) || value <= 0) return '时间未知';
      const date = new Date(value);
      const now = new Date();
      const diff = now.getTime() - value;
      if (diff >= 0 && diff < 60 * 1000) return '刚刚';
      if (diff >= 0 && diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / (60 * 1000)))} 分钟前`;
      if (sameDay(now, date)) return `今天 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      if (date.getFullYear() === now.getFullYear()) {
        return `${date.getMonth() + 1}月${date.getDate()}日`;
      }
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }

    /** Absolute date-time label: 今天/明天/日期 HH:mm. */
    function formatDateTime(timestamp) {
      const value = Number(timestamp);
      if (!Number.isFinite(value) || value <= 0) return '未设置';
      const date = new Date(value);
      const now = new Date();
      const dayDiff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / (24 * 60 * 60 * 1000));
      const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      if (dayDiff === 0) return `今天 ${time}`;
      if (dayDiff === 1) return `明天 ${time}`;
      if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
    }

    /** Convert a timestamp to the value expected by <input type="datetime-local">. */
    function toDateTimeLocalValue(timestamp) {
      const date = new Date(Number(timestamp) > 0 ? Number(timestamp) : Date.now());
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function parseDateTimeLocal(value) {
      if (typeof value !== 'string' || value === '') return NaN;
      const parsed = new Date(value);
      return parsed.getTime();
    }

    function clampCount(value, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) return 0;
      return Math.max(0, Math.min(Math.round(number), Math.max(0, Number(max) || 0)));
    }

    function outlineTitle(course, index) {
      const outline = course !== null && course !== undefined && Array.isArray(course.outline) ? course.outline : [];
      const item = outline[index];
      if (item && typeof item.title === 'string' && item.title !== '') return item.title;
      return `第 ${index + 1} 章`;
    }

    function clampInt(value, min, max, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.round(number)));
    }

    function formatShortDate(timestamp) {
      const value = Number(timestamp);
      if (!Number.isFinite(value) || value <= 0) return '—';
      const date = new Date(value);
      const now = new Date();
      if (date.getFullYear() !== now.getFullYear()) {
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
      }
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    /** Human label for a review due timestamp: 今天到期 / 逾期 N 天 / N 天后（日期）. */
    function formatReviewDue(due, now) {
      const dueAt = Number(due);
      const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      if (!Number.isFinite(dueAt) || dueAt <= 0) return '未排期';
      if (dueAt <= current) {
        const overdueDays = Math.floor((current - dueAt) / DAY_MS);
        return overdueDays <= 0 ? '今天到期' : `逾期 ${overdueDays} 天`;
      }
      const days = Math.max(1, Math.ceil((dueAt - current) / DAY_MS));
      return `${days} 天后（${formatShortDate(dueAt)}）`;
    }

    /** First spaced-repetition schedule, 1/3/7/14/30 days; a score below 60% resets to 1 day. */
    function nextReviewEntry(previousEntry, score, total, now) {
      const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const totalValue = Number(total) > 0 ? Number(total) : 0;
      const scoreValue = Number(score);
      const pct = totalValue > 0 && Number.isFinite(scoreValue) ? Math.round((scoreValue / totalValue) * 100) : 0;
      const previousReps =
        previousEntry !== null && previousEntry !== undefined && Number.isFinite(Number(previousEntry.reps))
          ? Number(previousEntry.reps)
          : 0;
      const reps = pct < 60 ? 0 : previousReps + 1;
      const intervalDays = pct < 60 ? 1 : REVIEW_INTERVALS[Math.min(reps, REVIEW_INTERVALS.length - 1)];
      return {
        due: at + intervalDays * DAY_MS,
        intervalDays,
        reps,
        lastScore: Math.max(0, Math.min(100, pct)),
        lastAt: at,
      };
    }

    /* ---------------------------------------------------------------- */
    /* localStorage (every access guarded)                               */
    /* ---------------------------------------------------------------- */

    function readStorageJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw === '') return fallback;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
        return parsed;
      } catch (error) {
        try {
          window.localStorage.removeItem(key);
        } catch (ignored) {
          /* storage unavailable; fall back to memory state */
        }
        return fallback;
      }
    }

    function writeStorageJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        return false;
      }
    }

    function readLastCourseId() {
      try {
        const raw = window.localStorage.getItem(LAST_KEY);
        return typeof raw === 'string' && raw !== '' ? raw : null;
      } catch (error) {
        return null;
      }
    }

    function writeLastCourseId(courseId) {
      try {
        if (typeof courseId === 'string' && courseId !== '') window.localStorage.setItem(LAST_KEY, courseId);
        else window.localStorage.removeItem(LAST_KEY);
      } catch (error) {
        /* storage unavailable; selection simply is not remembered */
      }
    }

    function normalizeProgressEntry(entry) {
      const source = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const done = Array.isArray(source.done)
        ? [...new Set(source.done.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < 100))].sort(
            (a, b) => a - b,
          )
        : [];
      const quiz = {};
      if (source.quiz !== null && typeof source.quiz === 'object' && !Array.isArray(source.quiz)) {
        for (const [key, value] of Object.entries(source.quiz)) {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= 100) continue;
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
          const score = Number(value.score);
          const total = Number(value.total);
          if (!Number.isFinite(score) || !Number.isFinite(total)) continue;
          quiz[index] = {
            score: clampInt(score, 0, 999, 0),
            total: clampInt(total, 1, 999, 1),
            answers: Array.isArray(value.answers)
              ? value.answers.map(Number).filter((answer) => Number.isInteger(answer)).slice(0, 20)
              : [],
            at: Number.isFinite(value.at) ? value.at : 0,
          };
        }
      }
      const review = {};
      if (source.review !== null && typeof source.review === 'object' && !Array.isArray(source.review)) {
        for (const [key, value] of Object.entries(source.review)) {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= 100) continue;
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
          review[index] = {
            due: Number.isFinite(value.due) ? value.due : 0,
            intervalDays: clampInt(value.intervalDays, 1, 365, 1),
            reps: clampInt(value.reps, 0, 999, 0),
            lastScore: clampInt(value.lastScore, 0, 100, 0),
            lastAt: Number.isFinite(value.lastAt) ? value.lastAt : 0,
          };
        }
      }
      const concepts = {};
      if (source.concepts !== null && source.concepts !== undefined && typeof source.concepts === 'object' && !Array.isArray(source.concepts)) {
        for (const [name, value] of Object.entries(source.concepts)) {
          if (typeof name !== 'string' || name.trim() === '') continue;
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
          const attempts = clampInt(value.attempts, 0, 999, 0);
          if (attempts === 0) continue;
          const correct = clampInt(value.correct, 0, attempts, 0);
          concepts[name] = {
            attempts,
            correct,
            mastery: clampInt(value.mastery, 0, 100, Math.round((correct / attempts) * 100)),
            updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
          };
        }
      }
      const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : 0;
      return { done, quiz, review, concepts, updatedAt };
    }

    function loadProgress() {
      const raw = readStorageJson(PROGRESS_KEY, {});
      const progress = {};
      for (const key of Object.keys(raw)) {
        progress[key] = normalizeProgressEntry(raw[key]);
      }
      return progress;
    }

    function isProgressEmpty(entry) {
      const value = normalizeProgressEntry(entry);
      return (
        value.done.length === 0 &&
        Object.keys(value.quiz).length === 0 &&
        Object.keys(value.review).length === 0 &&
        Object.keys(value.concepts).length === 0
      );
    }

    function sameProgress(a, b) {
      const left = normalizeProgressEntry(a);
      const right = normalizeProgressEntry(b);
      return (
        left.done.join(',') === right.done.join(',') &&
        JSON.stringify(left.quiz) === JSON.stringify(right.quiz) &&
        JSON.stringify(left.review) === JSON.stringify(right.review) &&
        JSON.stringify(left.concepts) === JSON.stringify(right.concepts)
      );
    }

    /** Union merge used by the one-time localStorage migration. */
    function mergeProgressEntries(base, overlay) {
      const left = normalizeProgressEntry(base);
      const right = normalizeProgressEntry(overlay);
      const done = [...new Set([...left.done, ...right.done])].sort((a, b) => a - b);
      return {
        done,
        quiz: { ...left.quiz, ...right.quiz },
        review: { ...left.review, ...right.review },
        concepts: { ...left.concepts, ...right.concepts },
        updatedAt: Math.max(left.updatedAt, right.updatedAt),
      };
    }

    function countReviewDue(progressEntry, now) {
      const entry = normalizeProgressEntry(progressEntry);
      const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      let due = 0;
      for (const value of Object.values(entry.review)) {
        if (value !== null && typeof value === 'object' && Number.isFinite(value.due) && value.due <= current) due += 1;
      }
      return due;
    }

    /** Review-tab buckets: due / unscheduled / upcoming, limited to generated chapters with a quiz. */
    function reviewChapterItems(course, progressEntry, now) {
      const outline = course !== null && Array.isArray(course.outline) ? course.outline : [];
      const chapters = course !== null && Array.isArray(course.chapters) ? course.chapters : [];
      const entry = normalizeProgressEntry(progressEntry);
      const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const items = [];
      for (let index = 0; index < outline.length; index += 1) {
        const chapter = chapters[index];
        if (chapter === null || chapter === undefined) continue;
        const questions =
          chapter.quiz !== null && chapter.quiz !== undefined && Array.isArray(chapter.quiz.questions)
            ? chapter.quiz.questions
            : [];
        if (questions.length === 0) continue;
        const review = entry.review[String(index)] !== undefined ? entry.review[String(index)] : null;
        const due = review !== null && Number.isFinite(Number(review.due)) ? Number(review.due) : null;
        items.push({
          index,
          title: outlineTitle(course, index),
          quizResult: entry.quiz[String(index)] !== undefined ? entry.quiz[String(index)] : null,
          review,
          due,
        });
      }
      const due = items.filter((item) => item.due !== null && item.due <= current).sort((a, b) => a.due - b.due);
      const unscheduled = items.filter((item) => item.due === null);
      const upcoming = items.filter((item) => item.due !== null && item.due > current).sort((a, b) => a.due - b.due);
      return { items, due, unscheduled, upcoming, total: items.length };
    }

    /* ---------------------------------------------------------------- */
    /* API                                                               */
    /* ---------------------------------------------------------------- */

    /**
     * Single entry point for the host API. Never times out: chapter
     * generation legitimately takes 1-3 minutes.
     */
    async function callApi(action, payload, options) {
      const body = { action, ...(payload !== null && typeof payload === 'object' ? payload : {}) };
      const signal = options !== null && options !== undefined && options.signal !== undefined ? options.signal : undefined;
      let response;
      try {
        response = await fetch(API_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (error !== null && error !== undefined && error.name === 'AbortError') throw error;
        throw new Error('无法连接 Harness 宿主，请刷新页面重试');
      }

      let json = null;
      try {
        json = await response.json();
      } catch (error) {
        throw new Error(response.ok ? '宿主返回了无法解析的响应' : `宿主返回 HTTP ${response.status}`);
      }

      if (json === null || typeof json !== 'object' || json.ok !== true) {
        const message =
          json !== null &&
          typeof json === 'object' &&
          json.error !== null &&
          typeof json.error === 'object' &&
          typeof json.error.message === 'string' &&
          json.error.message !== ''
            ? json.error.message
            : `请求失败（HTTP ${response.status}）`;
        const failure = new Error(message);
        if (json !== null && typeof json === 'object' && json.error && typeof json.error.code === 'string') {
          failure.code = json.error.code;
        }
        throw failure;
      }
      return json;
    }

    /* ---------------------------------------------------------------- */
    /* Chapter job API (multi-step Host pipeline)                        */
    /* ---------------------------------------------------------------- */

    const JOB_POLL_INTERVAL_MS = 1000;
    const JOB_POLL_MAX_MS = 15 * 60 * 1000;
    const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    const JOB_STEP_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']);

    function normalizeJobSnapshot(raw) {
      if (raw === null || raw === undefined || typeof raw !== 'object') return null;
      const steps = Array.isArray(raw.steps)
        ? raw.steps
            .filter((step) => step !== null && typeof step === 'object')
            .map((step) => ({
              key: typeof step.key === 'string' ? step.key : '',
              label: typeof step.label === 'string' ? step.label : '',
              status: JOB_STEP_STATUSES.has(step.status) ? step.status : 'pending',
              detail: typeof step.detail === 'string' ? step.detail : '',
            }))
        : [];
      const error =
        raw.error !== null && raw.error !== undefined && typeof raw.error === 'object'
          ? {
              code: typeof raw.error.code === 'string' ? raw.error.code : '',
              message: typeof raw.error.message === 'string' ? raw.error.message : '生成失败',
            }
          : null;
      return {
        id: typeof raw.id === 'string' ? raw.id : '',
        courseId: typeof raw.courseId === 'string' ? raw.courseId : '',
        index: Number.isInteger(raw.index) ? raw.index : null,
        status: JOB_STATUSES.has(raw.status) ? raw.status : 'running',
        currentStep: typeof raw.currentStep === 'string' ? raw.currentStep : null,
        steps,
        warnings: Array.isArray(raw.warnings)
          ? raw.warnings.filter((warning) => typeof warning === 'string' && warning !== '')
          : [],
        error,
        startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : 0,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
        result:
          raw.status === 'succeeded' && raw.result !== null && raw.result !== undefined && typeof raw.result === 'object'
            ? raw.result
            : null,
      };
    }

    function jobFailure(message, job, cancelled) {
      const failure = new Error(message);
      failure.job = job !== null && job !== undefined ? job : null;
      failure.cancelled = cancelled === true;
      if (job !== null && job !== undefined && job.error !== null && job.error !== undefined && job.error.code) {
        failure.code = job.error.code;
      }
      return failure;
    }

    function abortFailure() {
      const failure = new Error('已取消');
      failure.name = 'AbortError';
      failure.cancelled = true;
      return failure;
    }

    function sleepWithSignal(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal !== null && signal !== undefined && signal.aborted) {
          reject(abortFailure());
          return;
        }
        let timer = 0;
        const cleanup = () => {
          if (timer !== 0) {
            clearTimeout(timer);
            timer = 0;
          }
          if (signal !== null && signal !== undefined) signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(abortFailure());
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        if (signal !== null && signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    /** Start a chapter: returns either a fast-path chapter or a reusable JobSnapshot. */
    async function startChapterJob(id, index, force, signal) {
      const payload = { id, index };
      if (force === true) payload.force = true;
      const result = await callApi('chapter', payload, signal ? { signal } : undefined);
      if (result.chapter !== null && result.chapter !== undefined) {
        return { chapter: result.chapter, job: null, reused: false };
      }
      const job = normalizeJobSnapshot(result.job);
      if (job === null) throw new Error('宿主没有返回章节内容或生成任务');
      return { chapter: null, job, reused: result.reused === true };
    }

    /** Poll a job until it succeeds, fails, or is cancelled. Resolves to the chapter. */
    async function pollChapterJob(jobId, options) {
      const settings = options !== null && options !== undefined ? options : {};
      const onUpdate = typeof settings.onUpdate === 'function' ? settings.onUpdate : null;
      const signal = settings.signal;
      const startedAt = Date.now();
      for (;;) {
        if (signal !== null && signal !== undefined && signal.aborted) throw abortFailure();
        if (Date.now() - startedAt > JOB_POLL_MAX_MS) {
          throw jobFailure('生成任务超时，请重试', null, false);
        }
        const result = await callApi('job', { jobId }, signal ? { signal } : undefined);
        const job = normalizeJobSnapshot(result.job);
        if (job === null) throw new Error('宿主返回的任务状态无效');
        if (onUpdate !== null) onUpdate(job);
        if (job.status === 'succeeded') {
          const chapter =
            job.result !== null &&
            job.result.chapter !== null &&
            job.result.chapter !== undefined &&
            typeof job.result.chapter === 'object'
              ? job.result.chapter
              : null;
          if (chapter === null) throw jobFailure('任务已完成但缺少章节内容', job, false);
          return chapter;
        }
        if (job.status === 'failed') {
          throw jobFailure(job.error !== null ? job.error.message : '章节生成失败', job, false);
        }
        if (job.status === 'cancelled') throw jobFailure('已取消生成', job, true);
        await sleepWithSignal(JOB_POLL_INTERVAL_MS, signal);
      }
    }

    async function cancelChapterJob(jobId) {
      const result = await callApi('cancel', { jobId });
      return normalizeJobSnapshot(result.job);
    }

    /* ---------------------------------------------------------------- */
    /* Course helpers                                                    */
    /* ---------------------------------------------------------------- */

    function courseStats(course) {
      const outline = course !== null && Array.isArray(course.outline) ? course.outline : [];
      const chapters = course !== null && Array.isArray(course.chapters) ? course.chapters : [];
      const declared = Number(course !== null ? course.chapterCount : 0);
      const total = outline.length > 0 ? outline.length : Number.isFinite(declared) ? Math.max(0, declared) : 0;
      const generatedSet = new Set();
      for (let index = 0; index < total; index += 1) {
        if (chapters[index]) generatedSet.add(index);
      }
      const missing = [];
      for (let index = 0; index < total; index += 1) {
        if (!generatedSet.has(index)) missing.push(index);
      }
      return { total, generatedSet, missing, generatedCount: total - missing.length };
    }

    function summaryStats(summary) {
      const total = Math.max(0, Math.round(Number(summary !== null ? summary.chapterCount : 0) || 0));
      const generated = clampCount(summary !== null ? summary.generatedCount : 0, total);
      return { total, generated, missing: Math.max(0, total - generated) };
    }

    const DEFAULT_INITIAL_UNLOCKED = 2;
    const DEFAULT_MASTERY_THRESHOLD = 70;
    const MASTERY_THRESHOLD_OPTIONS = [60, 70, 80];

    /** Normalize the Host curriculum block; missing data degrades to a legacy all-unlocked course. */
    function normalizeCurriculum(raw, fallbackTotal) {
      const config = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : null;
      const legacy = config === null || config.legacy === true;
      const declaredTotal = Number(config !== null ? config.total : fallbackTotal);
      const outlineTotal = Math.max(0, Math.round(Number(fallbackTotal) || 0));
      const total = Number.isFinite(declaredTotal) && declaredTotal >= 0 ? Math.round(declaredTotal) : outlineTotal;
      const unlockedSource = config !== null && Array.isArray(config.unlocked) ? config.unlocked : null;
      const unlocked = (unlockedSource !== null ? unlockedSource : Array.from({ length: total }, (ignored, index) => index))
        .map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < total)
        .sort((a, b) => a - b);
      const unlockedSet = new Set(unlocked);
      const locked = config !== null && Array.isArray(config.locked)
        ? config.locked.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < total && !unlockedSet.has(index))
        : Array.from({ length: total }, (ignored, index) => index).filter((index) => !unlockedSet.has(index));
      const chapters = config !== null && Array.isArray(config.chapters)
        ? config.chapters
            .filter((chapter) => chapter !== null && typeof chapter === 'object')
            .map((chapter) => {
              const index = Number(chapter.index);
              if (!Number.isInteger(index) || index < 0 || index >= total) return null;
              return {
                index,
                title: typeof chapter.title === 'string' ? chapter.title : `第 ${index + 1} 章`,
                mastery: clampInt(chapter.mastery, 0, 100, 0),
                quizScore: Number.isFinite(Number(chapter.quizScore)) ? clampInt(chapter.quizScore, 0, 100, 0) : null,
                done: chapter.done === true,
                conceptCount: clampInt(chapter.conceptCount, 0, 999, 0),
                generated: chapter.generated === true,
                unlocked: unlockedSet.has(index),
              };
            })
            .filter((chapter) => chapter !== null)
        : [];
      let nextUnlock = null;
      if (config !== null && config.nextUnlock !== null && config.nextUnlock !== undefined && typeof config.nextUnlock === 'object') {
        const rawNext = config.nextUnlock;
        const index = Number(rawNext.index);
        if (Number.isInteger(index) && index >= 0 && index < total) {
          const requirements = Array.isArray(rawNext.requirements)
            ? rawNext.requirements
                .filter((item) => item !== null && typeof item === 'object')
                .map((item) => ({
                  key: typeof item.key === 'string' ? item.key : '',
                  label: typeof item.label === 'string' ? item.label : '',
                  met: item.met === true,
                  detail: typeof item.detail === 'string' ? item.detail : '',
                }))
            : [];
          nextUnlock = {
            index,
            chapterTitle: typeof rawNext.chapterTitle === 'string' ? rawNext.chapterTitle : `第 ${index + 1} 章`,
            requirements,
            ready: requirements.length > 0 && requirements.every((item) => item.met),
          };
        }
      }
      const stageSize = clampInt(config !== null ? config.stageSize : 3, 2, 12, 3);
      const stageThreshold = clampInt(
        config !== null && config.stageThreshold !== undefined ? config.stageThreshold : config !== null ? config.masteryThreshold : DEFAULT_MASTERY_THRESHOLD,
        30,
        100,
        DEFAULT_MASTERY_THRESHOLD,
      );
      const stages = config !== null && Array.isArray(config.stages)
        ? config.stages
            .filter((stage) => stage !== null && typeof stage === 'object')
            .map((stage) => {
              const index = Number(stage.index);
              if (!Number.isInteger(index) || index < 0) return null;
              const chapterIndexes = Array.isArray(stage.chapterIndexes)
                ? stage.chapterIndexes.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < total)
                : [];
              const result = stage.result !== null && stage.result !== undefined && typeof stage.result === 'object'
                ? {
                    score: clampInt(stage.result.score, 0, 999, 0),
                    total: clampInt(stage.result.total, 1, 999, 1),
                    percent: clampInt(stage.result.percent, 0, 100, 0),
                    at: Number.isFinite(Number(stage.result.at)) ? Number(stage.result.at) : 0,
                    passed: stage.result.passed === true,
                  }
                : null;
              return {
                index,
                title: typeof stage.title === 'string' ? stage.title : `阶段 ${index + 1}`,
                startChapterIndex: clampInt(stage.startChapterIndex, 0, Math.max(0, total - 1), 0),
                endChapterIndex: clampInt(stage.endChapterIndex, 0, Math.max(0, total - 1), 0),
                chapterIndexes,
                chapterTitles: Array.isArray(stage.chapterTitles) ? stage.chapterTitles.filter((title) => typeof title === 'string') : [],
                available: stage.available === true,
                result,
                threshold: clampInt(stage.threshold, 30, 100, stageThreshold),
              };
            })
            .filter((stage) => stage !== null)
        : [];
      return {
        total,
        initialUnlocked: clampInt(config !== null ? config.initialUnlocked : total, 1, Math.max(1, total), legacy ? total : Math.min(DEFAULT_INITIAL_UNLOCKED, total)),
        masteryThreshold: clampInt(config !== null ? config.masteryThreshold : DEFAULT_MASTERY_THRESHOLD, 30, 100, DEFAULT_MASTERY_THRESHOLD),
        stageSize,
        stageThreshold,
        stages,
        legacy,
        unlocked,
        locked,
        nextUnlock,
        chapters,
      };
    }

    function courseTotalChapters(course) {
      const outline = course !== null && Array.isArray(course.outline) ? course.outline : [];
      if (outline.length > 0) return outline.length;
      return Math.max(0, Number(course !== null ? course.chapterCount : 0) || 0);
    }

    function curriculumOf(course) {
      return normalizeCurriculum(course !== null ? course.curriculum : null, courseTotalChapters(course));
    }

    function isLegacyCurriculum(course) {
      return curriculumOf(course).legacy;
    }

    function chapterIsUnlocked(course, index) {
      const total = courseTotalChapters(course);
      if (total === 0 || index < 0 || index >= total) return true;
      const curriculum = curriculumOf(course);
      if (curriculum.legacy) return true;
      if (curriculum.unlocked.includes(index)) return true;
      const chapters = course !== null && Array.isArray(course.chapters) ? course.chapters : [];
      const chapter = chapters[index];
      return chapter !== null && chapter !== undefined && chapter.unlocked === true;
    }

    function unlockedCountOf(course) {
      const curriculum = curriculumOf(course);
      return curriculum.legacy ? curriculum.total : curriculum.unlocked.length;
    }

    function unlockHintFor(course, index) {
      const curriculum = curriculumOf(course);
      const threshold = curriculum.masteryThreshold;
      const previous = Math.max(1, index);
      if (curriculum.stageSize > 1 && index > 0 && index % curriculum.stageSize === 0) {
        return `通过阶段 ${index / curriculum.stageSize} 测评（≥ ${curriculum.stageThreshold}%），并完成第 ${previous} 章、测验与概念掌握达到 ${threshold}% 后解锁`;
      }
      return `完成第 ${previous} 章并让测验与概念掌握达到 ${threshold}% 后解锁`;
    }

    function normalizeMastery(raw) {
      if (raw === null || raw === undefined || typeof raw !== 'object') return null;
      const chapters = Array.isArray(raw.chapters)
        ? raw.chapters
            .filter((chapter) => chapter !== null && typeof chapter === 'object')
            .map((chapter) => {
              const index = Number(chapter.index);
              if (!Number.isInteger(index) || index < 0) return null;
              const concepts = Array.isArray(chapter.concepts)
                ? chapter.concepts
                    .filter((concept) => concept !== null && typeof concept === 'object' && typeof concept.name === 'string' && concept.name !== '')
                    .map((concept) => ({
                      name: concept.name,
                      mastery: clampInt(concept.mastery, 0, 100, 0),
                      attempts: clampInt(concept.attempts, 0, 999, 0),
                      correct: clampInt(concept.correct, 0, 999, 0),
                    }))
                : [];
              return {
                index,
                title: typeof chapter.title === 'string' ? chapter.title : `第 ${index + 1} 章`,
                unlocked: chapter.unlocked === true,
                done: chapter.done === true,
                generated: chapter.generated === true,
                quizScore: Number.isFinite(Number(chapter.quizScore)) ? clampInt(chapter.quizScore, 0, 100, 0) : null,
                mastery: clampInt(chapter.mastery, 0, 100, 0),
                concepts,
              };
            })
            .filter((chapter) => chapter !== null)
        : [];
      const weakest = Array.isArray(raw.weakest)
        ? raw.weakest
            .filter((concept) => concept !== null && typeof concept === 'object' && typeof concept.name === 'string' && concept.name !== '')
            .map((concept) => ({
              name: concept.name,
              mastery: clampInt(concept.mastery, 0, 100, 0),
              attempts: clampInt(concept.attempts, 0, 999, 0),
              correct: clampInt(concept.correct, 0, 999, 0),
              chapterIndex: Number.isInteger(concept.chapterIndex) ? concept.chapterIndex : null,
              chapterTitle: typeof concept.chapterTitle === 'string' ? concept.chapterTitle : '',
            }))
        : [];
      if (chapters.length === 0 && !Number.isFinite(Number(raw.overall))) return null;
      return {
        overall: clampInt(raw.overall, 0, 100, 0),
        chapters,
        weakest,
      };
    }

    function masteryOf(course) {
      return normalizeMastery(course !== null ? course.mastery : null);
    }

    function quizScoreLabel(score) {
      return Number.isFinite(Number(score)) ? `${clampInt(score, 0, 100, 0)}%` : '未测';
    }

    function unlockNoticeText(curriculum, newlyUnlocked, course) {
      const indexes = Array.isArray(newlyUnlocked)
        ? [...new Set(newlyUnlocked.map(Number).filter((index) => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b)
        : [];
      if (indexes.length === 0) return '';
      const outline = course !== null && Array.isArray(course.outline) ? course.outline : [];
      const titles = indexes.map((index) => {
        const chapter = curriculum !== null && curriculum !== undefined && Array.isArray(curriculum.chapters)
          ? curriculum.chapters.find((item) => item.index === index)
          : null;
        const title =
          (chapter && chapter.title) ||
          (outline[index] && typeof outline[index].title === 'string' ? outline[index].title : '') ||
          '';
        return `第 ${index + 1} 章${title !== '' ? `：${title}` : ''}`;
      });
      return `已解锁${titles.join('、')}。`;
    }

    /** Return a new course object with one generated chapter merged in. */
    function withChapter(course, chapter) {
      if (course === null || chapter === null || !Number.isInteger(chapter.index) || chapter.index < 0) return course;
      const outline = Array.isArray(course.outline) ? course.outline : [];
      const total = outline.length > 0 ? outline.length : Math.max(0, Number(course.chapterCount) || 0);
      const index = chapter.index;
      if (total > 0 && index >= total) return course;
      const length = Math.max(total, index + 1);
      const chapters = Array.isArray(course.chapters) ? course.chapters.slice() : [];
      while (chapters.length < length) chapters.push(null);
      chapters[index] = {
        index,
        number: index + 1,
        title:
          typeof chapter.title === 'string' && chapter.title !== ''
            ? chapter.title
            : (outline[index] && outline[index].title) || `第 ${index + 1} 章`,
        markdown: typeof chapter.markdown === 'string' ? chapter.markdown : '',
        quiz: chapter.quiz !== undefined && chapter.quiz !== null ? chapter.quiz : null,
        concepts: chapter.concepts !== undefined && chapter.concepts !== null ? chapter.concepts : null,
      };
      const generated = [];
      for (let position = 0; position < length; position += 1) {
        if (chapters[position]) generated.push(position);
      }
      return { ...course, chapters, status: generated.length >= length ? 'complete' : 'generating' };
    }

    /* ================================================================ */
    /* Markdown renderer (pure function, no HTML injection)             */
    /* MARKDOWN_RENDERER_START                                           */
    /* ================================================================ */

    const CODE_FOLD_LINE_LIMIT = 16;
    const LANGUAGE_ALIASES = {
      js: 'javascript',
      ts: 'typescript',
      py: 'python',
      sh: 'bash',
      shell: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      'c++': 'cpp',
      cs: 'csharp',
      html: 'markup',
      xml: 'markup',
      md: 'markdown',
      text: 'plaintext',
      txt: 'plaintext',
      plain: 'plaintext',
    };

    const RE_HEADING = /^(#{1,6})[ \t]+(.*)$/;
    const RE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^`]*)?[ \t]*$/;
    const RE_HR = /^[ \t]*((?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
    const RE_QUOTE = /^[ \t]*>[ \t]?(.*)$/;
    const RE_LIST_ITEM = /^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;

    function safeHref(raw) {
      if (typeof raw !== 'string') return null;
      const value = raw.trim();
      if (value === '') return null;
      if (/^(?:https?:\/\/|mailto:)/i.test(value)) return value;
      if (/^[./#]/.test(value)) return value;
      return null;
    }

    function isInlineSpecial(char) {
      return char === '`' || char === '*' || char === '[' || char === '$';
    }

    /** Find the closing single `*` of an italic run, skipping `**` pairs. */
    function findItalicEnd(text, from) {
      let index = from;
      while (index < text.length) {
        if (text[index] === '*' && text[index - 1] !== '*' && text[index + 1] !== '*') return index;
        index += 1;
      }
      return -1;
    }

    function getKatex() {
      try {
        if (typeof window === 'undefined') return null;
        const katex = window.katex;
        return katex !== null && katex !== undefined && typeof katex.renderToString === 'function' ? katex : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * Render one math expression. KaTeX's output is one of five trusted innerHTML
     * sinks in this file (KaTeX x2, Prism, Mermaid, sanitized SVG); everything
     * else is escaped React text. Falls back to a plain <code> node when KaTeX is
     * unavailable or rendering throws. Note KaTeX always runs with trust:false.
     */
    function renderMathNode(tex, displayMode, canMath, key) {
      const source = typeof tex === 'string' ? tex : String(tex === null || tex === undefined ? '' : tex);
      const katex = canMath ? getKatex() : null;
      if (katex !== null) {
        try {
          const html = katex.renderToString(source, {
            displayMode: Boolean(displayMode),
            throwOnError: false,
            strict: 'ignore',
            trust: false,
          });
          return displayMode
            ? h('div', { key, className: 'ls-math-block', dangerouslySetInnerHTML: { __html: html } })
            : h('span', { key, className: 'ls-math-inline', dangerouslySetInnerHTML: { __html: html } });
        } catch (error) {
          /* fall through to the raw fallback */
        }
      }
      return displayMode
        ? h('div', { key, className: 'ls-math-block' }, h('code', { className: 'ls-math-raw' }, source))
        : h('code', { key, className: 'ls-math-raw' }, source);
    }

    /** Normalize a fence info string's first word into a Prism language id. */
    function normalizeLanguage(rawLanguage) {
      const raw = typeof rawLanguage === 'string' ? rawLanguage.trim() : '';
      if (raw === '') return 'plaintext';
      const first = raw.split(/\s+/)[0].toLowerCase();
      if (first === '') return 'plaintext';
      if (Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, first)) return LANGUAGE_ALIASES[first];
      const safe = first.replace(/[^a-z0-9#+._-]/g, '');
      return safe === '' ? 'plaintext' : safe;
    }

    function getPrism() {
      try {
        if (typeof window === 'undefined') return null;
        const prism = window.Prism;
        return prism !== null && prism !== undefined && typeof prism.highlight === 'function' ? prism : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * Highlight one fenced block with Prism. Prism escapes the source before
     * wrapping tokens, so its HTML is safe to inject; failures fall back to text.
     */
    function highlightCode(code, language, canHighlight) {
      const prism = canHighlight === true ? getPrism() : null;
      if (prism === null) return null;
      const languages = prism.languages !== null && prism.languages !== undefined ? prism.languages : null;
      if (languages === null || languages[language] === undefined || languages[language] === null) return null;
      try {
        const html = prism.highlight(code, languages[language], language);
        return typeof html === 'string' && html !== '' ? html : null;
      } catch (error) {
        return null;
      }
    }

    /** Clipboard write with a legacy execCommand fallback; never throws. */
    async function writeClipboardText(text) {
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard !== null &&
          navigator.clipboard !== undefined &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        /* fall through to the legacy path */
      }
      let textarea = null;
      try {
        if (typeof document === 'undefined' || document.body === null) return false;
        textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        return copied === true;
      } catch (error) {
        return false;
      } finally {
        if (textarea !== null && textarea.parentNode !== null) {
          try {
            textarea.parentNode.removeChild(textarea);
          } catch (error) {
            /* already detached */
          }
        }
      }
    }

    /* ---------------------------------------------------------------- */
    /* Mermaid (lazy) and sanitized inline SVG                           */
    /* ---------------------------------------------------------------- */

    let mermaidScriptNode = null;
    let mermaidLoadTimer = 0;
    const mermaidRuntime = { promise: null, status: 'idle' };
    const mermaidInitState = { key: null };
    let mermaidRenderSequence = 0;

    function getMermaid() {
      try {
        if (typeof window === 'undefined') return null;
        const mermaid = window.mermaid;
        return mermaid !== null &&
          mermaid !== undefined &&
          typeof mermaid.render === 'function' &&
          typeof mermaid.initialize === 'function'
          ? mermaid
          : null;
      } catch (error) {
        return null;
      }
    }

    function isDarkTheme() {
      try {
        return (
          typeof document !== 'undefined' && document.body !== null && document.body.hasAttribute('data-ds-dark-theme')
        );
      } catch (error) {
        return false;
      }
    }

    function dispatchLearningEvent(name) {
      try {
        if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
          window.dispatchEvent(new CustomEvent(name));
        }
      } catch (error) {
        /* event delivery is best-effort */
      }
    }

    /** Remove the lazily injected Mermaid script (plugin disposal / retry). */
    function disposeMermaidAssets() {
      mermaidRuntime.promise = null;
      mermaidRuntime.status = 'idle';
      if (mermaidLoadTimer !== 0) {
        clearTimeout(mermaidLoadTimer);
        mermaidLoadTimer = 0;
      }
      if (mermaidScriptNode !== null) {
        try {
          mermaidScriptNode.remove();
        } catch (error) {
          /* already detached */
        }
        mermaidScriptNode = null;
      }
    }

    /** Load the vendored Mermaid UMD bundle once; callers share one promise. */
    function loadMermaid() {
      const existing = getMermaid();
      if (existing !== null) return Promise.resolve(existing);
      if (mermaidRuntime.promise !== null) return mermaidRuntime.promise;
      if (mermaidRuntime.status === 'failed') return Promise.reject(new Error('图表引擎加载失败，请重试'));

      mermaidRuntime.status = 'loading';
      mermaidRuntime.promise = new Promise((resolve, reject) => {
        if (typeof document === 'undefined' || document.head === null) {
          mermaidRuntime.status = 'failed';
          mermaidRuntime.promise = null;
          reject(new Error('当前环境不支持图表渲染'));
          return;
        }
        const clearLoadTimer = () => {
          if (mermaidLoadTimer !== 0) {
            clearTimeout(mermaidLoadTimer);
            mermaidLoadTimer = 0;
          }
        };
        const fail = (message) => {
          clearLoadTimer();
          mermaidRuntime.status = 'failed';
          mermaidRuntime.promise = null;
          reject(new Error(message));
        };
        mermaidLoadTimer = setTimeout(() => {
          mermaidLoadTimer = 0;
          if (mermaidRuntime.status === 'loading') {
            if (mermaidScriptNode !== null) {
              try {
                mermaidScriptNode.remove();
              } catch (error) {
                /* already detached */
              }
              mermaidScriptNode = null;
            }
            fail('图表引擎加载超时，请重试');
          }
        }, 60000);
        const script = document.createElement('script');
        script.src = MERMAID_JS_SRC;
        script.async = true;
        script.setAttribute(VENDOR_ATTR, 'mermaid');
        const onLoad = () => {
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
          clearLoadTimer();
          const mermaid = getMermaid();
          if (mermaid === null) {
            fail('图表引擎加载失败');
            return;
          }
          mermaidRuntime.status = 'ready';
          dispatchLearningEvent(MERMAID_READY_EVENT);
          resolve(mermaid);
        };
        const onError = () => {
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
          clearLoadTimer();
          try {
            script.remove();
          } catch (error) {
            /* already detached */
          }
          if (mermaidScriptNode === script) mermaidScriptNode = null;
          fail('图表引擎加载失败，请检查后重试');
        };
        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
        mermaidScriptNode = script;
        document.head.appendChild(script);
      });
      return mermaidRuntime.promise;
    }

    function retryMermaid() {
      disposeMermaidAssets();
      return loadMermaid();
    }

    function readHostThemeColor(name, fallback) {
      try {
        if (typeof window === 'undefined' || typeof document === 'undefined' || document.body === null) return fallback;
        const value = window.getComputedStyle(document.body).getPropertyValue(name).trim();
        return value === '' ? fallback : value;
      } catch (error) {
        return fallback;
      }
    }

    /** Re-initialize Mermaid for the current light/dark variant with host theme colors. */
    function initializeMermaid(mermaid, dark) {
      const key = dark ? 'dark' : 'light';
      if (mermaidInitState.key === key) return;
      const themeVariables = {
        darkMode: dark,
        fontFamily: 'inherit',
        fontSize: '14px',
        background: readHostThemeColor('--dsw-alias-bg-base', dark ? '#1b1f24' : '#ffffff'),
        primaryColor: readHostThemeColor('--dsw-alias-bg-layer-2', dark ? '#23272e' : '#f2f4f8'),
        primaryTextColor: readHostThemeColor('--dsw-alias-label-primary', dark ? '#e6e6e6' : '#1f2328'),
        primaryBorderColor: readHostThemeColor('--dsw-alias-border-l2', dark ? '#3a4048' : '#d0d7de'),
        secondaryColor: readHostThemeColor('--dsw-alias-bg-layer-1', dark ? '#1f242b' : '#f8fafc'),
        tertiaryColor: readHostThemeColor('--dsw-alias-bg-layer-2', dark ? '#23272e' : '#f2f4f8'),
        lineColor: readHostThemeColor('--dsw-alias-label-secondary', dark ? '#b8bcc4' : '#57606a'),
        textColor: readHostThemeColor('--dsw-alias-label-primary', dark ? '#e6e6e6' : '#1f2328'),
        mainBkg: readHostThemeColor('--dsw-alias-bg-layer-2', dark ? '#23272e' : '#f2f4f8'),
        nodeBorder: readHostThemeColor('--dsw-alias-border-l2', dark ? '#3a4048' : '#d0d7de'),
        clusterBkg: readHostThemeColor('--dsw-alias-bg-layer-1', dark ? '#1f242b' : '#f8fafc'),
        clusterBorder: readHostThemeColor('--dsw-alias-border-l1', dark ? '#30363d' : '#d8dee4'),
        edgeLabelBackground: readHostThemeColor('--dsw-alias-bg-base', dark ? '#1b1f24' : '#ffffff'),
      };
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'base',
          themeVariables,
          logLevel: 'fatal',
        });
        mermaidInitState.key = key;
      } catch (error) {
        /* initialize failures fall through to the render error path */
      }
    }

    /** Serialize Mermaid renders so multiple diagrams on one page cannot race. */
    let mermaidRenderChain = Promise.resolve();
    function renderMermaidSafely(mermaid, code, dark) {
      const task = () => {
        initializeMermaid(mermaid, dark);
        mermaidRenderSequence += 1;
        return mermaid.render(`ls-mermaid-${mermaidRenderSequence}`, code);
      };
      const run = mermaidRenderChain.then(task, task);
      mermaidRenderChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    /**
     * Mermaid diagram. Uses `mermaid.render` only (never run/startOnLoad); the
     * returned SVG comes from the trusted library and is the 4th innerHTML sink.
     */
    const MERMAID_DIAGRAM_LABELS = {
      flowchart: '流程图',
      graph: '关系图',
      sequenceDiagram: '时序图',
      classDiagram: '类图',
      stateDiagram: '状态图',
      'stateDiagram-v2': '状态图',
      erDiagram: 'ER 图',
      gantt: '甘特图',
      pie: '饼图',
      journey: '旅程图',
      mindmap: '思维导图',
      timeline: '时间线',
      quadrantChart: '象限图',
      requirementDiagram: '需求图',
      gitGraph: 'Git 图',
      C4Context: 'C4 图',
      sankey: '桑基图',
      xychart: '图表',
      block: '块图',
      packet: '数据包图',
      architecture: '架构图',
      radar: '雷达图',
    };

    function mermaidDiagramLabel(source) {
      const first = String(source === null || source === undefined ? '' : source)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '' && !line.startsWith('%%'));
      if (first === undefined) return '图表';
      const keyword = first.split(/\s+/)[0].replace(/:$/, '');
      return MERMAID_DIAGRAM_LABELS[keyword] || '图表';
    }

    function MermaidDiagram({ code }) {
      const source = typeof code === 'string' ? code.trim() : '';
      const diagramLabel = React.useMemo(() => mermaidDiagramLabel(source), [source]);
      const [showSource, setShowSource] = React.useState(false);
      const [state, setState] = React.useState('loading');
      const [svg, setSvg] = React.useState('');
      const [error, setError] = React.useState('');
      const [attempt, setAttempt] = React.useState(0);
      const [dark, setDark] = React.useState(() => isDarkTheme());

      React.useEffect(() => {
        if (typeof document === 'undefined' || document.body === null || typeof MutationObserver === 'undefined') {
          return undefined;
        }
        const observer = new MutationObserver(() => setDark(isDarkTheme()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        return () => observer.disconnect();
      }, []);

      React.useEffect(() => {
        let cancelled = false;
        setState('loading');
        setError('');
        const run = async () => {
          try {
            const mermaid = await loadMermaid();
            if (cancelled) return;
            const result = await renderMermaidSafely(mermaid, source, dark);
            if (cancelled) return;
            const output = result !== null && result !== undefined && typeof result.svg === 'string' ? result.svg : '';
            if (output.trim() === '') throw new Error('图表内容为空');
            setSvg(output);
            setState('ready');
          } catch (failure) {
            if (cancelled) return;
            setError(failure !== null && failure !== undefined && failure.message ? failure.message : '图表渲染失败');
            setState('error');
          }
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [source, dark, attempt]);

      if (state === 'ready') {
        return h(
          'div',
          { className: 'ls-mermaid' },
          h(
            'div',
            { className: 'ls-mermaid-head' },
            h(
              'div',
              { className: 'ls-mermaid-head-main' },
              h('span', { className: 'ls-mermaid-badge' }, 'Mermaid'),
              h('span', { className: 'ls-mermaid-title' }, diagramLabel),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm ls-btn-ghost ls-mermaid-toggle',
                onClick: () => setShowSource((value) => !value),
                'aria-expanded': showSource ? 'true' : 'false',
              },
              showSource ? '收起源码' : '查看源码',
            ),
          ),
          showSource
            ? h('div', { className: 'ls-mermaid-source' }, h(CodeBlock, { code: source, language: 'mermaid', rawLanguage: 'mermaid', canHighlight: false }))
            : h('div', {
                className: 'ls-mermaid-svg',
                dangerouslySetInnerHTML: { __html: svg },
              }),
        );
      }
      if (state === 'error') {
        return h(
          'div',
          { className: 'ls-mermaid-error' },
          h('div', { className: 'ls-mermaid-error-text' }, `图表渲染失败：${error}`),
          h(
            'div',
            { className: 'ls-mermaid-error-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm',
                onClick: () => {
                  disposeMermaidAssets();
                  setAttempt((value) => value + 1);
                },
              },
              '重试',
            ),
          ),
          h(CodeBlock, { code: source, language: 'mermaid', rawLanguage: 'mermaid', canHighlight: false }),
        );
      }
      return h(
        'div',
        { className: 'ls-mermaid-loading' },
        h('span', { className: 'ls-spinner', 'aria-hidden': true }),
        '正在渲染图表…',
      );
    }

    function looksLikeSvgMarkup(text) {
      const trimmed = String(text === null || text === undefined ? '' : text)
        .replace(/^\uFEFF/, '')
        .trim();
      const withoutDeclaration = trimmed.replace(/^<\?xml[^>]*>\s*/i, '');
      return /^<svg[\s>]/i.test(withoutDeclaration);
    }

    /**
     * Sanitize a standalone SVG with DOMParser: drop scripts/styles/foreign
     * objects/images/links, inline event handlers, javascript: values and
     * external hrefs; require a viewBox. Returns serialized markup.
     */
    function sanitizeSvgMarkup(source) {
      const text = typeof source === 'string' ? source.trim() : '';
      if (text === '') return { ok: false, reason: 'SVG 内容为空', markup: '' };
      if (!looksLikeSvgMarkup(text)) return { ok: false, reason: '不是有效的 SVG 内容', markup: '' };
      if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
        return { ok: false, reason: '当前环境不支持 SVG 解析', markup: '' };
      }
      try {
        const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
        const parserError = parsed.querySelector('parsererror');
        if (parserError !== null) return { ok: false, reason: 'SVG 解析失败', markup: '' };
        const root = parsed.documentElement;
        if (root === null || root === undefined || String(root.tagName || '').toLowerCase() !== 'svg') {
          return { ok: false, reason: 'SVG 根节点无效', markup: '' };
        }
        if (!root.hasAttribute('viewBox')) return { ok: false, reason: 'SVG 缺少 viewBox', markup: '' };
        if (root.children === undefined || root.children === null || root.children.length === 0) {
          return { ok: false, reason: 'SVG 内容为空', markup: '' };
        }

        const blockedTags = new Set(['script', 'style', 'foreignobject', 'iframe', 'image', 'a']);
        const elements = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const element of elements) {
          const tag = String(element.tagName || '').toLowerCase();
          if (blockedTags.has(tag)) {
            if (element !== root) element.remove();
            continue;
          }
          const attributes = Array.from(element.attributes || []);
          for (const attribute of attributes) {
            const name = String(attribute.name || '');
            const lowerName = name.toLowerCase();
            const value = String(attribute.value || '').trim();
            if (lowerName.startsWith('on')) {
              element.removeAttribute(name);
              continue;
            }
            if (/javascript:/i.test(value.replace(/[\u0000-\u0020]+/g, ''))) {
              element.removeAttribute(name);
              continue;
            }
            if (lowerName === 'href' || lowerName === 'xlink:href') {
              if (!value.startsWith('#')) element.removeAttribute(name);
              continue;
            }
          }
          const styleValue = element.getAttribute('style');
          if (styleValue !== null && (/javascript:/i.test(styleValue) || /url\s*\(/i.test(styleValue))) {
            element.removeAttribute('style');
          }
        }
        if (root.children === undefined || root.children === null || root.children.length === 0) {
          return { ok: false, reason: 'SVG 内容为空', markup: '' };
        }
        return { ok: true, reason: '', markup: new XMLSerializer().serializeToString(root) };
      } catch (error) {
        return { ok: false, reason: 'SVG 清洗失败', markup: '' };
      }
    }

    /** Sanitized standalone SVG figure; the 5th innerHTML sink (cleaned markup). */
    function SvgFigure({ source }) {
      const text = typeof source === 'string' ? source : '';
      const cleaned = React.useMemo(() => sanitizeSvgMarkup(text), [text]);
      if (!cleaned.ok) {
        return h(
          'div',
          { className: 'ls-svg-fallback' },
          h('div', { className: 'ls-svg-fallback-title' }, '示意图无法渲染'),
          h('div', { className: 'ls-svg-fallback-note' }, cleaned.reason || 'SVG 内容无效'),
          h('pre', { className: 'ls-svg-fallback-raw' }, text.slice(0, 4000)),
        );
      }
      return h(
        'figure',
        { className: 'ls-svg-figure' },
        h('span', { className: 'ls-svg-badge' }, '示意图'),
        h('div', {
          className: 'ls-svg-canvas',
          dangerouslySetInnerHTML: { __html: cleaned.markup },
        }),
      );
    }

    /** Collect a bare multi-line `<svg ...>...</svg>` block; returns null if unclosed. */
    function parseBareSvgBlock(lines, start) {
      const first = String(lines[start] === null || lines[start] === undefined ? '' : lines[start]).trim();
      if (!/^<svg[\s>]/i.test(first)) return null;
      const collected = [];
      let index = start;
      while (index < lines.length) {
        collected.push(lines[index]);
        if (/<\/svg\s*>/i.test(lines[index])) {
          return { source: collected.join('\n'), next: index + 1 };
        }
        index += 1;
      }
      return null;
    }


    /** Fenced code block: Prism highlighting, line numbers, scroll shadows, fold, copy. */
    function CodeBlock({ code, language, rawLanguage, canHighlight }) {
      const text = typeof code === 'string' ? code : '';
      const lineCount = text === '' ? 1 : text.split('\n').length;
      const gutterDigits = String(lineCount).length;
      const lineNumbers = React.useMemo(
        () => Array.from({ length: lineCount }, (ignore, index) => index + 1),
        [lineCount],
      );
      const collapsible = lineCount > CODE_FOLD_LINE_LIMIT;
      const [collapsed, setCollapsed] = React.useState(collapsible);
      const [copied, setCopied] = React.useState(false);
      const aliveRef = React.useRef(true);
      const copyTimerRef = React.useRef(0);
      const scrollRef = React.useRef(null);
      const bodyRef = React.useRef(null);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (copyTimerRef.current !== 0) window.clearTimeout(copyTimerRef.current);
          copyTimerRef.current = 0;
        };
      }, []);

      const highlighted = React.useMemo(
        () => highlightCode(text, language, canHighlight === true),
        [text, language, canHighlight],
      );

      const updateScrollShadows = React.useCallback(() => {
        const wrapper = scrollRef.current;
        const body = bodyRef.current;
        if (wrapper === null || body === null) return;
        const maxX = body.scrollWidth - body.clientWidth;
        const maxY = body.scrollHeight - body.clientHeight;
        const setFlag = (name, enabled) => {
          if (enabled) wrapper.setAttribute(name, '');
          else wrapper.removeAttribute(name);
        };
        setFlag('data-shadow-left', maxX > 1 && body.scrollLeft > 1);
        setFlag('data-shadow-right', maxX > 1 && body.scrollLeft < maxX - 1);
        setFlag('data-shadow-top', maxY > 1 && body.scrollTop > 1);
        setFlag('data-shadow-bottom', maxY > 1 && body.scrollTop < maxY - 1);
      }, []);

      React.useEffect(() => {
        updateScrollShadows();
      }, [collapsed, lineCount, updateScrollShadows]);

      React.useEffect(() => {
        const body = bodyRef.current;
        if (body === null) return undefined;
        let observer = null;
        let timer = 0;
        const schedule = () => {
          if (timer !== 0) return;
          timer = window.setTimeout(() => {
            timer = 0;
            updateScrollShadows();
          }, 16);
        };
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(schedule);
          observer.observe(body);
        } else {
          window.addEventListener('resize', schedule);
        }
        schedule();
        return () => {
          if (timer !== 0) window.clearTimeout(timer);
          if (observer !== null) observer.disconnect();
          else window.removeEventListener('resize', schedule);
        };
      }, [updateScrollShadows, collapsed, highlighted]);

      const copy = () => {
        void writeClipboardText(text).then((ok) => {
          if (!aliveRef.current || ok !== true) return;
          setCopied(true);
          if (copyTimerRef.current !== 0) window.clearTimeout(copyTimerRef.current);
          copyTimerRef.current = window.setTimeout(() => {
            copyTimerRef.current = 0;
            if (aliveRef.current) setCopied(false);
          }, 1500);
        });
      };

      const label = language === 'plaintext' ? 'TEXT' : language.toUpperCase();
      const codeNode =
        highlighted !== null
          ? h('code', {
              className: `language-${language}`,
              // Trusted Prism output: Prism escapes the source before wrapping tokens.
              dangerouslySetInnerHTML: { __html: highlighted },
            })
          : h('code', { className: `language-${language}` }, text);

      return h(
        'div',
        { className: 'ls-code', 'data-language': language },
        h(
          'div',
          { className: 'ls-code-head' },
          h('span', { className: 'ls-code-lang' }, label),
          h('span', { className: 'ls-code-lines' }, `${lineCount} 行`),
          h(
            'div',
            { className: 'ls-code-actions' },
            collapsible
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-code-action',
                    onClick: () => setCollapsed((value) => !value),
                    'aria-expanded': collapsed ? 'false' : 'true',
                  },
                  collapsed ? `展开代码（${lineCount} 行）` : '收起',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'ls-code-action',
                onClick: copy,
                'aria-label': '复制代码',
              },
              copied ? '已复制' : '复制',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ls-code-scroll', ref: scrollRef, 'data-collapsed': collapsed ? '' : undefined },
          h('div', { className: 'ls-code-fade ls-code-fade-top', 'aria-hidden': true }),
          h('div', { className: 'ls-code-fade ls-code-fade-bottom', 'aria-hidden': true }),
          h('div', { className: 'ls-code-fade ls-code-fade-left', 'aria-hidden': true }),
          h('div', { className: 'ls-code-fade ls-code-fade-right', 'aria-hidden': true }),
          h(
            'div',
            {
              className: 'ls-code-body',
              ref: bodyRef,
              'data-collapsed': collapsed ? '' : undefined,
              onScroll: updateScrollShadows,
            },
            h(
              'div',
              {
                className: 'ls-code-gutter',
                'aria-hidden': true,
                style: { width: `${Math.max(2, gutterDigits)}ch` },
              },
              lineNumbers.map((number) =>
                h('span', { key: number, className: 'ls-code-line-no' }, String(number)),
              ),
            ),
            h('pre', { className: 'ls-code-pre' }, codeNode),
          ),
        ),
      );
    }

    /** Closing `$` of a heuristic inline formula; skips `$$` pairs and escaped dollars. */
    function findInlineDollarEnd(text, from) {
      let index = from;
      while (index < text.length) {
        const char = text[index];
        if (char === '\\' && text[index + 1] === '$') {
          index += 2;
          continue;
        }
        if (char === '$') {
          if (text[index + 1] === '$') {
            index += 2;
            continue;
          }
          return index;
        }
        if (char === '\n') return -1;
        index += 1;
      }
      return -1;
    }

    function matchInlineDollarMath(text, index) {
      if (text[index] !== '$' || text[index + 1] === '$') return null;
      const end = findInlineDollarEnd(text, index + 1);
      if (end === -1) return null;
      const tex = text.slice(index + 1, end);
      if (tex === '' || tex.length >= 500) return null;
      if (tex.trim() !== tex) return null;
      if (tex.includes('\n')) return null;
      return { tex, end };
    }

    /** Parse inline Markdown into React nodes. Text nodes stay escaped by React. */
    function renderInline(text, keyPrefix, canMath) {
      const nodes = [];
      let buffer = '';
      let index = 0;
      let counter = 0;

      const flush = () => {
        if (buffer !== '') {
          nodes.push(buffer);
          buffer = '';
        }
      };

      while (index < text.length) {
        const char = text[index];

        // Inline math: \( ... \)
        if (char === '\\' && text[index + 1] === '(') {
          const end = text.indexOf('\\)', index + 2);
          if (end !== -1) {
            const tex = text.slice(index + 2, end);
            if (tex.trim() !== '') {
              flush();
              nodes.push(renderMathNode(tex.trim(), false, canMath, `${keyPrefix}-m${counter++}`));
              index = end + 2;
              continue;
            }
          }
        }

        // Inline math heuristic: $...$
        if (char === '$') {
          const math = matchInlineDollarMath(text, index);
          if (math !== null) {
            flush();
            nodes.push(renderMathNode(math.tex, false, canMath, `${keyPrefix}-m${counter++}`));
            index = math.end + 1;
            continue;
          }
        }

        if (char === '\\' && index + 1 < text.length && isInlineSpecial(text[index + 1])) {
          buffer += text[index + 1];
          index += 2;
          continue;
        }

        if (char === '`') {
          const end = text.indexOf('`', index + 1);
          if (end !== -1) {
            flush();
            const code = text.slice(index + 1, end).replace(/\n/g, ' ');
            nodes.push(h('code', { key: `${keyPrefix}-c${counter++}`, className: 'ls-inline-code' }, code));
            index = end + 1;
            continue;
          }
          buffer += char;
          index += 1;
          continue;
        }

        if (char === '*') {
          const bold = text[index + 1] === '*';
          const marker = bold ? '**' : '*';
          const start = index + marker.length;
          const end = bold ? text.indexOf(marker, start) : findItalicEnd(text, start);
          if (end > start && text.slice(start, end).trim() !== '') {
            flush();
            const inner = renderInline(
              text.slice(start, end),
              `${keyPrefix}-${bold ? 'b' : 'i'}${counter}`,
              canMath,
            );
            nodes.push(
              bold
                ? h('strong', { key: `${keyPrefix}-s${counter++}` }, inner)
                : h('em', { key: `${keyPrefix}-e${counter++}` }, inner),
            );
            index = end + marker.length;
            continue;
          }
          buffer += char;
          index += 1;
          continue;
        }

        if (char === '[') {
          const labelEnd = text.indexOf(']', index + 1);
          if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
            const parenEnd = text.indexOf(')', labelEnd + 2);
            if (parenEnd !== -1) {
              const label = text.slice(index + 1, labelEnd);
              const href = safeHref(text.slice(labelEnd + 2, parenEnd));
              flush();
              if (href === null) {
                nodes.push(...renderInline(label, `${keyPrefix}-t${counter}`, canMath));
              } else {
                nodes.push(
                  h(
                    'a',
                    { key: `${keyPrefix}-a${counter++}`, href, target: '_blank', rel: 'noopener noreferrer' },
                    label,
                  ),
                );
              }
              index = parenEnd + 1;
              continue;
            }
          }
          buffer += char;
          index += 1;
          continue;
        }

        buffer += char;
        index += 1;
      }

      flush();
      return nodes;
    }

    function splitTableRow(line) {
      let value = String(line).trim();
      if (value.startsWith('|')) value = value.slice(1);
      if (value.endsWith('|')) value = value.slice(0, -1);
      const cells = [];
      let cell = '';
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\' && value[index + 1] === '|') {
          cell += '|';
          index += 1;
          continue;
        }
        if (char === '|') {
          cells.push(cell.trim());
          cell = '';
          continue;
        }
        cell += char;
      }
      cells.push(cell.trim());
      return cells;
    }

    function isTableStart(lines, index) {
      const header = lines[index];
      const separator = lines[index + 1];
      if (typeof header !== 'string' || typeof separator !== 'string') return false;
      if (!header.includes('|') || !separator.includes('|')) return false;
      const cells = splitTableRow(separator);
      if (cells.length === 0) return false;
      return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
    }

    function parseAlignments(cells) {
      return cells.map((cell) => {
        const value = cell.trim();
        const left = value.startsWith(':');
        const right = value.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
    }

    function listIndent(match) {
      return match[1].replace(/\t/g, '    ').length;
    }

    function rawIndent(line) {
      const match = /^[ \t]*/.exec(line);
      return match === null ? 0 : match[0].replace(/\t/g, '    ').length;
    }

    function stripNestedIndent(line) {
      if (line.trim() === '') return '';
      return line.replace(/^[ \t]{1,4}/, '');
    }

    /** Parse one list block (supports one nested level) into a React list. */
    function parseListBlock(lines, start, keyPrefix, canMath) {
      const first = RE_LIST_ITEM.exec(lines[start]);
      if (first === null) return null;
      const baseIndent = listIndent(first);
      const ordered = /^\d/.test(first[2]);
      const items = [];
      let cursor = start;
      let current = null;

      while (cursor < lines.length) {
        const line = lines[cursor];

        if (line.trim() === '') {
          let next = cursor + 1;
          while (next < lines.length && lines[next].trim() === '') next += 1;
          const nextMatch = next < lines.length ? RE_LIST_ITEM.exec(lines[next]) : null;
          // A blank line continues the same list only when the next item has the
          // same kind (ordered/unordered) and indent; otherwise start a new block.
          if (
            nextMatch !== null &&
            listIndent(nextMatch) <= baseIndent + 1 &&
            /^\d/.test(nextMatch[2]) === ordered
          ) {
            cursor = next;
            continue;
          }
          break;
        }

        const match = RE_LIST_ITEM.exec(line);
        if (match !== null) {
          const indent = listIndent(match);
          if (indent <= baseIndent + 1) {
            if (indent + 1 < baseIndent) break;
            current = { text: match[3], nestedLines: [] };
            items.push(current);
            cursor += 1;
            continue;
          }

          if (current === null) break;
          const nestedStart = cursor;
          let probe = cursor;
          while (probe < lines.length) {
            const candidate = lines[probe];
            if (candidate.trim() === '') {
              let next = probe + 1;
              while (next < lines.length && lines[next].trim() === '') next += 1;
              const nextMatch = next < lines.length ? RE_LIST_ITEM.exec(lines[next]) : null;
              if (nextMatch !== null && listIndent(nextMatch) > baseIndent + 1) {
                probe = next;
                continue;
              }
              break;
            }
            const nestedMatch = RE_LIST_ITEM.exec(candidate);
            if (nestedMatch !== null) {
              if (listIndent(nestedMatch) <= baseIndent + 1) break;
              probe += 1;
              continue;
            }
            if (rawIndent(candidate) > baseIndent) {
              probe += 1;
              continue;
            }
            break;
          }
          const nestedSlice = lines.slice(nestedStart, probe);
          if (nestedSlice.length > 0) current.nestedLines.push(...nestedSlice);
          cursor = probe;
          continue;
        }

        if (current !== null && rawIndent(line) > baseIndent) {
          current.text += `\n${line.trim()}`;
          cursor += 1;
          continue;
        }
        break;
      }

      if (items.length === 0) return null;

      const children = items.map((item, itemIndex) => {
        const nested =
          item.nestedLines.length > 0
            ? parseListBlock(
                item.nestedLines.map(stripNestedIndent),
                0,
                `${keyPrefix}-n${itemIndex}`,
                canMath,
              )
            : null;
        return h(
          'li',
          { key: `${keyPrefix}-li${itemIndex}` },
          renderInline(item.text, `${keyPrefix}-li${itemIndex}`, canMath),
          nested !== null ? nested.node : null,
        );
      });

      const tag = ordered ? 'ol' : 'ul';
      const startNumber = ordered ? Number.parseInt(first[2], 10) : NaN;
      const startAttribute = Number.isFinite(startNumber) && startNumber > 1 ? startNumber : undefined;
      return {
        node: h(tag, { key: `${keyPrefix}-list`, start: startAttribute }, children),
        next: cursor,
      };
    }

    function looksLikeBlockMathStart(line) {
      const trimmed = String(line).trim();
      return trimmed.startsWith('$$') || trimmed.startsWith('\\[');
    }

    /**
     * Parse a display-math block starting at `start`:
     *   $$ ... $$   (single line or multi line)   and   \[ ... \]
     * Returns null when the line is not a closed math block.
     */
    function parseBlockMath(lines, start) {
      const line = lines[start];
      const trimmed = line.trim();

      if (trimmed.startsWith('$$')) {
        const rest = trimmed.slice(2);
        const inlineClose = rest.indexOf('$$');
        if (inlineClose !== -1) {
          const tex = rest.slice(0, inlineClose).trim();
          const tail = rest.slice(inlineClose + 2).trim();
          if (tex !== '' && tail === '') return { tex, next: start + 1 };
          return null;
        }
        const content = [];
        if (rest.trim() !== '') content.push(rest.trim());
        let index = start + 1;
        while (index < lines.length) {
          const current = lines[index];
          const at = current.indexOf('$$');
          if (at !== -1) {
            const before = current.slice(0, at).trim();
            const after = current.slice(at + 2).trim();
            if (after !== '') return null;
            if (before !== '') content.push(before);
            const tex = content.join('\n').trim();
            return tex === '' ? null : { tex, next: index + 1 };
          }
          content.push(current);
          index += 1;
        }
        return null;
      }

      if (trimmed.startsWith('\\[')) {
        const rest = trimmed.slice(2);
        const inlineClose = rest.indexOf('\\]');
        if (inlineClose !== -1) {
          const tex = rest.slice(0, inlineClose).trim();
          const tail = rest.slice(inlineClose + 2).trim();
          if (tex !== '' && tail === '') return { tex, next: start + 1 };
          return null;
        }
        const content = [];
        if (rest.trim() !== '') content.push(rest.trim());
        let index = start + 1;
        while (index < lines.length) {
          const current = lines[index];
          const at = current.indexOf('\\]');
          if (at !== -1) {
            const before = current.slice(0, at).trim();
            const after = current.slice(at + 2).trim();
            if (after !== '') return null;
            if (before !== '') content.push(before);
            const tex = content.join('\n').trim();
            return tex === '' ? null : { tex, next: index + 1 };
          }
          content.push(current);
          index += 1;
        }
        return null;
      }

      return null;
    }

    const CALLOUT_KINDS = {
      note: { label: '备注', icon: 'i' },
      tip: { label: '提示', icon: '✦' },
      info: { label: '信息', icon: 'i' },
      warning: { label: '注意', icon: '!' },
      caution: { label: '警告', icon: '!' },
      concept: { label: '概念', icon: '◆' },
      question: { label: '问题', icon: '?' },
      answer: { label: '答案', icon: '✓' },
      quiz: { label: '小测', icon: '?' },
    };

    function parseCalloutHeader(line) {
      const match = /^\s*\[!([A-Za-z][A-Za-z0-9_-]*)\]([+-])?(?:[ \t]+(.*))?$/.exec(
        String(line === null || line === undefined ? '' : line),
      );
      if (match === null) return null;
      const kind = match[1].toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(CALLOUT_KINDS, kind)) return null;
      return {
        kind,
        fold: match[2] === '-' ? 'collapsed' : match[2] === '+' ? 'expanded' : 'none',
        title: typeof match[3] === 'string' ? match[3].trim() : '',
      };
    }

    /** Render a quote block, turning an `> [!kind]` header into a callout. */
    function renderQuoteLines(quoteLines, key, canMath, canHighlight) {
      const header = quoteLines.length > 0 ? parseCalloutHeader(quoteLines[0]) : null;
      if (header === null) {
        return h(
          'blockquote',
          { key, className: 'ls-quote' },
          renderBlocks(quoteLines, `${key}-quote`, canMath, canHighlight),
        );
      }

      const bodyLines = quoteLines.slice(1);
      while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift();
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
      const body = renderBlocks(bodyLines, `${key}-callout`, canMath, canHighlight);
      const meta = CALLOUT_KINDS[header.kind];
      const collapsible = header.fold !== 'none';
      const expanded = header.fold !== 'collapsed';
      const closedLabel = header.kind === 'answer' ? '查看答案' : '展开';

      const headChildren = [
        h('span', { key: 'icon', className: 'ls-callout-icon', 'aria-hidden': true }, meta.icon),
        h('span', { key: 'label', className: 'ls-callout-label' }, meta.label),
        header.title !== '' ? h('span', { key: 'title', className: 'ls-callout-title' }, header.title) : null,
        collapsible
          ? h(
              'span',
              { key: 'toggle', className: 'ls-callout-toggle' },
              h('span', { className: 'ls-callout-toggle-closed' }, closedLabel),
              h('span', { className: 'ls-callout-toggle-opened' }, '收起'),
              h('span', { className: 'ls-callout-chevron', 'aria-hidden': true }, '▸'),
            )
          : null,
      ].filter((child) => child !== null);

      const head = h(collapsible ? 'summary' : 'div', { className: 'ls-callout-head' }, headChildren);
      const bodyNode = h('div', { className: 'ls-callout-body' }, body);

      if (collapsible) {
        return h(
          'details',
          { key, className: 'ls-callout', 'data-kind': header.kind, open: expanded ? true : undefined },
          head,
          bodyNode,
        );
      }
      return h('div', { key, className: 'ls-callout', 'data-kind': header.kind }, head, bodyNode);
    }

    function renderBlocks(lines, prefix, canMath, canHighlight) {
      const blocks = [];
      let index = 0;
      const nextKey = () => `${prefix}-${blocks.length}`;

      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === '') {
          index += 1;
          continue;
        }

        // Fenced code block: content inside a fence is never parsed as math.
        const fence = RE_FENCE.exec(line);
        if (fence !== null) {
          const marker = fence[1][0];
          const markerLength = fence[1].length;
          const closing = new RegExp(`^[ \\t]*${marker === '`' ? '`' : '~'}{${markerLength},}[ \\t]*$`);
          const codeLines = [];
          index += 1;
          while (index < lines.length) {
            if (closing.test(lines[index])) {
              index += 1;
              break;
            }
            codeLines.push(lines[index]);
            index += 1;
          }
          const key = nextKey();
          const rawLanguage = (fence[2] || '').trim();
          const codeText = codeLines.join('\n');
          const firstWord = rawLanguage.split(/\s+/)[0].toLowerCase();
          if (firstWord === 'svg' || ((firstWord === 'xml' || firstWord === '') && looksLikeSvgMarkup(codeText))) {
            blocks.push(h(SvgFigure, { key, source: codeText }));
          } else if (firstWord === 'mermaid') {
            blocks.push(h(MermaidDiagram, { key, code: codeText }));
          } else {
            blocks.push(
              h(CodeBlock, {
                key,
                code: codeText,
                language: normalizeLanguage(rawLanguage),
                rawLanguage,
                canHighlight: canHighlight === true,
              }),
            );
          }
          continue;
        }

        // Bare multi-line <svg> blocks (independent block, continues afterwards).
        const bareSvg = parseBareSvgBlock(lines, index);
        if (bareSvg !== null) {
          blocks.push(h(SvgFigure, { key: nextKey(), source: bareSvg.source }));
          index = bareSvg.next;
          continue;
        }

        // Display math: $$ ... $$ and \[ ... \]
        const mathBlock = parseBlockMath(lines, index);
        if (mathBlock !== null) {
          blocks.push(renderMathNode(mathBlock.tex, true, canMath, nextKey()));
          index = mathBlock.next;
          continue;
        }

        // Headings.
        const heading = RE_HEADING.exec(line);
        if (heading !== null) {
          const level = heading[1].length;
          const key = nextKey();
          blocks.push(h(`h${level}`, { key }, renderInline(heading[2], key, canMath)));
          index += 1;
          continue;
        }

        // Horizontal rule.
        if (RE_HR.test(line)) {
          blocks.push(h('hr', { key: nextKey() }));
          index += 1;
          continue;
        }

        // Blockquote.
        if (RE_QUOTE.test(line)) {
          const key = nextKey();
          const quoteLines = [];
          while (index < lines.length && RE_QUOTE.test(lines[index])) {
            quoteLines.push(RE_QUOTE.exec(lines[index])[1]);
            index += 1;
          }
          blocks.push(renderQuoteLines(quoteLines, key, canMath, canHighlight));
          continue;
        }

        // Table.
        if (isTableStart(lines, index)) {
          const key = nextKey();
          const headerCells = splitTableRow(line);
          const alignments = parseAlignments(splitTableRow(lines[index + 1]));
          index += 2;
          const rows = [];
          while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
            rows.push(splitTableRow(lines[index]));
            index += 1;
          }
          blocks.push(
            h(
              'div',
              { key, className: 'ls-table-wrap' },
              h(
                'table',
                { className: 'ls-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    headerCells.map((cell, columnIndex) =>
                      h(
                        'th',
                        {
                          key: columnIndex,
                          style: alignments[columnIndex] ? { textAlign: alignments[columnIndex] } : undefined,
                        },
                        renderInline(cell, `${key}-th${columnIndex}`, canMath),
                      ),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((cells, rowIndex) =>
                    h(
                      'tr',
                      { key: rowIndex },
                      headerCells.map((ignored, columnIndex) => {
                        const cell = cells[columnIndex] !== undefined ? cells[columnIndex] : '';
                        return h(
                          'td',
                          {
                            key: columnIndex,
                            style: alignments[columnIndex] ? { textAlign: alignments[columnIndex] } : undefined,
                          },
                          renderInline(cell, `${key}-td${rowIndex}-${columnIndex}`, canMath),
                        );
                      }),
                    ),
                  ),
                ),
              ),
            ),
          );
          continue;
        }

        // Lists.
        if (RE_LIST_ITEM.test(line)) {
          const key = nextKey();
          const parsed = parseListBlock(lines, index, key, canMath);
          if (parsed !== null) {
            blocks.push(parsed.node);
            index = parsed.next;
            continue;
          }
        }

        // Paragraph: consume until a blank line or another block marker.
        const paragraph = [];
        while (index < lines.length) {
          const current = lines[index];
          if (current.trim() === '') break;
          if (RE_HEADING.test(current) || RE_FENCE.test(current) || RE_HR.test(current) || RE_QUOTE.test(current)) {
            break;
          }
          if (RE_LIST_ITEM.test(current) || isTableStart(lines, index)) break;
          if (looksLikeBlockMathStart(current) && parseBlockMath(lines, index) !== null) break;
          if (/^\s*<svg[\s>]/i.test(current) && parseBareSvgBlock(lines, index) !== null) break;
          paragraph.push(current);
          index += 1;
        }
        if (paragraph.length === 0) {
          index += 1;
          continue;
        }
        const key = nextKey();
        blocks.push(h('p', { key }, renderInline(paragraph.join('\n'), key, canMath)));
      }

      return blocks;
    }

    function renderMarkdown(markdown, canMath, canHighlight) {
      const text = typeof markdown === 'string' ? markdown : String(markdown === null || markdown === undefined ? '' : markdown);
      return renderBlocks(
        text.replace(/\r\n?/g, '\n').split('\n'),
        'md',
        Boolean(canMath),
        Boolean(canHighlight),
      );
    }

    function MarkdownView({ markdown, katexReady, prismReady }) {
      const blocks = React.useMemo(
        () => renderMarkdown(markdown, katexReady === true, prismReady === true),
        [markdown, katexReady, prismReady],
      );
      return h('div', { className: 'ls-md' }, blocks);
    }

    /* MARKDOWN_RENDERER_END */

    /* ---------------------------------------------------------------- */
    /* Styles                                                            */
    /* ---------------------------------------------------------------- */

    const LS_CSS = `
.ls-page{display:flex;flex-direction:column;height:100%;min-height:100%;box-sizing:border-box;padding:calc(var(--dsh-frame-top-clearance,0px) + 16px) clamp(16px,2.4vw,28px) 20px;gap:14px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.5}
.ls-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;flex:none}
.ls-header-main{min-width:0;display:flex;flex-direction:column;gap:4px}
.ls-title{margin:0;font-size:22px;line-height:1.25;font-weight:600;letter-spacing:.01em}
.ls-subtitle{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(64vw,620px)}
.ls-header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ls-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease}
.ls-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ls-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ls-btn:disabled{opacity:.5;cursor:not-allowed}
.ls-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);font-weight:600}
.ls-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-bg-layer-1));border-color:var(--dsw-alias-brand-primary)}
.ls-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.ls-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ls-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary);font-weight:600}
.ls-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,var(--dsw-alias-bg-layer-1));border-color:var(--dsw-alias-state-error-primary)}
.ls-btn-sm{height:26px;padding:0 9px;font-size:12px;border-radius:6px}
.ls-banner{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:1.55;flex:none}
.ls-banner[data-kind="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary)}
.ls-banner[data-kind="success"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-success-primary)}
.ls-banner[data-kind="info"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary)}
.ls-banner-text{flex:1;min-width:0;word-break:break-word;color:inherit}
.ls-banner-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1;cursor:pointer;opacity:.75}
.ls-banner-close:hover{opacity:1;background:var(--dsw-alias-bg-layer-2)}
.ls-body{display:flex;gap:16px;flex:1;min-height:0}
.ls-sidebar{width:320px;flex:0 0 320px;display:flex;flex-direction:column;min-height:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ls-sidebar-top{flex:none;display:flex;flex-direction:column;gap:6px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ls-search{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4}
.ls-search::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.ls-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ls-sidebar-count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-list{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.ls-list::-webkit-scrollbar,.ls-detail-scroll::-webkit-scrollbar,.ls-reader-scroll::-webkit-scrollbar,.ls-panel-scroll::-webkit-scrollbar,.ls-table-wrap::-webkit-scrollbar,.ls-code-body::-webkit-scrollbar{width:8px;height:8px}
.ls-list::-webkit-scrollbar-thumb,.ls-detail-scroll::-webkit-scrollbar-thumb,.ls-reader-scroll::-webkit-scrollbar-thumb,.ls-panel-scroll::-webkit-scrollbar-thumb,.ls-table-wrap::-webkit-scrollbar-thumb,.ls-code-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.ls-card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);cursor:pointer;text-align:left;transition:background .12s ease,border-color .12s ease}
.ls-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ls-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ls-card[data-selected]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-base))}
.ls-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.ls-card-title{min-width:0;font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);word-break:break-word}
.ls-card-delete-wrap{flex:none;display:flex;align-items:center;gap:4px;min-height:24px}
.ls-card-delete{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s ease,background .12s ease,color .12s ease}
.ls-card:hover .ls-card-delete,.ls-card:focus-within .ls-card-delete{opacity:1;pointer-events:auto}
.ls-card-delete:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.ls-confirm{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.ls-tags{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ls-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border:1px solid transparent;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap}
.ls-tag-domain{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.ls-tag-level{color:var(--dsw-alias-label-secondary)}
.ls-tag-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-tag-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.ls-tag-idle{color:var(--dsw-alias-state-idle-primary)}
.ls-card-meta{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-card-foot{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-progress{position:relative;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ls-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.ls-progress-fill[data-tone="success"]{background:var(--dsw-alias-state-success-primary)}
.ls-progress-fill[data-tone="error"]{background:var(--dsw-alias-state-error-primary)}
.ls-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 16px;text-align:center;color:var(--dsw-alias-label-secondary)}
.ls-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-empty-text{margin:0;font-size:12px;line-height:1.65;max-width:260px}
.ls-empty-icon{color:var(--dsw-alias-label-secondary);opacity:.55}
.ls-skeleton-card{height:92px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);position:relative;overflow:hidden}
.ls-skeleton-card::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent),transparent);animation:ls-shimmer 1.4s infinite}
@keyframes ls-shimmer{100%{transform:translateX(100%)}}
.ls-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px}
.ls-panel{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ls-panel-scroll{flex:1;min-height:0;overflow-y:auto;padding:20px 24px 28px}
.ls-loading{display:flex;align-items:center;gap:10px;padding:28px;color:var(--dsw-alias-label-secondary);font-size:13px}
.ls-placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;margin:16px;padding:40px 24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary);min-height:220px}
.ls-placeholder-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-placeholder-text{margin:0;font-size:12.5px;line-height:1.7;max-width:360px}
.ls-detail-head{flex:none;display:flex;flex-direction:column;gap:10px;padding:18px 24px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ls-detail-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ls-detail-title-wrap{min-width:0;display:flex;flex-direction:column;gap:8px}
.ls-detail-title{margin:0;font-size:19px;line-height:1.35;font-weight:600;word-break:break-word}
.ls-detail-sub{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ls-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ls-detail-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-dot{opacity:.6}
.ls-detail-scroll{flex:1;min-height:0;overflow-y:auto;padding:16px 24px 28px}
.ls-chapter-list{display:flex;flex-direction:column;gap:8px}
.ls-chapter-row{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);transition:border-color .12s ease,background .12s ease}
.ls-chapter-row:hover{border-color:var(--dsw-alias-border-l2)}
.ls-chapter-row[data-active]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-base))}
.ls-chapter-no{flex:none;width:28px;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-idle-primary)}
.ls-chapter-row[data-generated] .ls-chapter-no{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-chapter-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ls-chapter-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13.5px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary);word-break:break-word}
.ls-chapter-summary{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ls-chapter-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-chapter-actions{flex:none;display:flex;align-items:center;gap:6px;align-self:center}
.ls-chapter-busy{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-chapter-row[data-locked]{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,var(--dsw-alias-bg-base));border-style:dashed;cursor:default}
.ls-chapter-row[data-locked]:hover{border-color:var(--dsw-alias-border-l1)}
.ls-chapter-row[data-locked] .ls-chapter-title,.ls-chapter-row[data-locked] .ls-chapter-summary{color:var(--dsw-alias-label-secondary)}
.ls-chapter-row[data-locked] .ls-chapter-no{border-style:dashed;background:transparent;color:var(--dsw-alias-label-secondary)}
.ls-lock-badge{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border:1px dashed var(--dsw-alias-border-l2);border-radius:999px;font-size:10.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.ls-chapter-lock-hint{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);opacity:.9}
.ls-chapter-locked{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-unlock-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-unlock-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px}
.ls-unlock-count{font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-unlock-next{color:var(--dsw-alias-label-secondary)}
.ls-unlock-done{color:var(--dsw-alias-state-success-primary)}
.ls-unlock-req-list{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.ls-unlock-req{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ls-unlock-req-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent);color:var(--dsw-alias-state-error-primary);font-size:10px;font-weight:700}
.ls-unlock-req[data-met] .ls-unlock-req-mark{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-unlock-req-label{color:var(--dsw-alias-label-primary)}
.ls-unlock-req-detail{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-mastery{display:flex;flex-direction:column;gap:14px}
.ls-mastery-overview{display:flex;flex-direction:column;gap:8px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.ls-mastery-overview-main{display:flex;align-items:baseline;gap:10px}
.ls-mastery-number{font-size:34px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}
.ls-mastery-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-mastery-caption{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.ls-mastery-section{display:flex;flex-direction:column;gap:10px}
.ls-mastery-section-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-mastery-chapters{display:flex;flex-direction:column;gap:8px}
.ls-mastery-chapter{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.ls-mastery-chapter[data-locked]{border-style:dashed;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,var(--dsw-alias-bg-base))}
.ls-mastery-chapter-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ls-mastery-chapter-title-wrap{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-mastery-chapter-title{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary);word-break:break-word}
.ls-mastery-chapter-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-mastery-chapter-scores{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.ls-mastery-score{display:inline-flex;flex-direction:column;gap:1px}
.ls-mastery-score-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.ls-mastery-score-label{font-size:10px;color:var(--dsw-alias-label-secondary)}
.ls-mastery-concepts{display:flex;flex-wrap:wrap;gap:6px}
.ls-mastery-concept{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ls-mastery-concept[data-untested]{border-style:dashed;color:var(--dsw-alias-label-secondary);background:transparent}
.ls-mastery-concept-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-mastery-concept-score{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);font-weight:600}
.ls-mastery-concept[data-untested] .ls-mastery-concept-score{color:var(--dsw-alias-label-secondary);font-weight:400}
.ls-mastery-empty-line{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-weakest-list{display:flex;flex-direction:column;gap:6px}
.ls-weakest-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.ls-weakest-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-weakest-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-word}
.ls-weakest-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-chips{display:flex;flex-wrap:wrap;gap:4px}
.ls-chip{padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1;white-space:nowrap}
.ls-done-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary);font-size:10.5px;font-weight:500;line-height:1;white-space:nowrap}
.ls-gen-bar{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-border-l1));border-radius:10px;background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1))}
.ls-gen-bar[data-failed]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1))}
.ls-gen-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ls-gen-text{flex:1;min-width:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);word-break:break-word}
.ls-gen-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ls-gen-steps{display:flex;flex-direction:column;gap:5px;padding-top:7px;border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent)}
.ls-gen-steps-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ls-gen-steps-count{font-variant-numeric:tabular-nums}
.ls-gen-step-list{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;padding:0;list-style:none}
.ls-gen-step{display:inline-flex;align-items:center;gap:5px;min-width:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ls-gen-step[data-current]{color:var(--dsw-alias-label-primary);font-weight:500}
.ls-gen-step .ls-spinner{width:12px;height:12px;border-width:1.5px;vertical-align:0}
.ls-gen-step-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1}
.ls-gen-step[data-status="done"] .ls-gen-step-glyph{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-success-primary)}
.ls-gen-step[data-status="failed"] .ls-gen-step-glyph{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary)}
.ls-gen-step[data-status="failed"] .ls-gen-step-label{color:var(--dsw-alias-state-error-primary)}
.ls-gen-step[data-status="cancelled"] .ls-gen-step-glyph{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary)}
.ls-gen-step[data-status="skipped"] .ls-gen-step-glyph{background:transparent;border:1px dashed var(--dsw-alias-border-l2)}
.ls-gen-step-detail{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10px}
.ls-gen-warnings{display:flex;align-items:flex-start;gap:6px;padding:5px 8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.ls-gen-warnings-icon{flex:none;color:var(--dsw-alias-state-warn-primary)}
.ls-spinner{flex:none;display:inline-block;width:14px;height:14px;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:ls-spin .8s linear infinite;vertical-align:-2px}
.ls-spinner[data-tone="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent);border-top-color:var(--dsw-alias-state-error-primary)}
@keyframes ls-spin{to{transform:rotate(360deg)}}
.ls-reader-bar{flex:none;display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.ls-reader-nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ls-reader-center{flex:1;min-width:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center}
.ls-reader-counter{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ls-reader-title-row{display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;max-width:100%}
.ls-reader-title{font-size:14px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ls-reader-scroll{flex:1;min-height:0;overflow-y:auto}
.ls-reader-inner{max-width:760px;margin:0 auto;padding:30px 28px 64px;box-sizing:border-box}
.ls-md{font-size:15px;line-height:1.78;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;word-break:break-word}
.ls-md h1,.ls-md h2,.ls-md h3,.ls-md h4,.ls-md h5,.ls-md h6{margin:26px 0 12px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-md h1{margin-top:6px;font-size:22px}
.ls-md h2{padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:19px}
.ls-md h3{font-size:16.5px}
.ls-md h4{font-size:15px}
.ls-md h5{font-size:14px}
.ls-md h6{font-size:13px;color:var(--dsw-alias-label-secondary)}
.ls-md p{margin:0 0 14px}
.ls-md ul,.ls-md ol{margin:0 0 14px;padding-left:24px}
.ls-md li{margin:4px 0}
.ls-md li>ul,.ls-md li>ol{margin:4px 0}
.ls-md blockquote.ls-quote{margin:0 0 16px;padding:12px 16px;border-left:3px solid var(--dsw-alias-border-l2);border-radius:0 8px 8px 0;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);color:var(--dsw-alias-label-secondary)}
.ls-md blockquote.ls-quote p{white-space:pre-wrap}
.ls-md blockquote.ls-quote p:last-child{margin-bottom:0}
.ls-callout{margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-left:4px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ls-callout[data-kind="tip"],.ls-callout[data-kind="answer"]{border-left-color:var(--dsw-alias-state-success-primary)}
.ls-callout[data-kind="warning"],.ls-callout[data-kind="caution"]{border-left-color:var(--dsw-alias-state-warn-primary)}
.ls-callout[data-kind="question"],.ls-callout[data-kind="quiz"]{border-left-color:var(--dsw-alias-state-idle-primary)}
.ls-callout-head{display:flex;align-items:center;gap:8px;padding:9px 14px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);list-style:none}
summary.ls-callout-head{cursor:pointer}
summary.ls-callout-head::-webkit-details-marker{display:none}
summary.ls-callout-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ls-callout-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:700;line-height:1}
.ls-callout:is([data-kind="tip"],[data-kind="answer"]) .ls-callout-icon{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-callout:is([data-kind="warning"],[data-kind="caution"]) .ls-callout-icon{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.ls-callout:is([data-kind="question"],[data-kind="quiz"]) .ls-callout-icon{background:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 18%,transparent);color:var(--dsw-alias-state-idle-primary)}
.ls-callout-label{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1.6}
.ls-callout-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ls-callout-toggle{flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-callout-chevron{display:inline-block;font-size:10px;transition:transform .15s ease}
details.ls-callout[open] .ls-callout-chevron{transform:rotate(90deg)}
.ls-callout-toggle-opened{display:none}
details.ls-callout[open] .ls-callout-toggle-closed{display:none}
details.ls-callout[open] .ls-callout-toggle-opened{display:inline}
.ls-callout-body{padding:2px 14px 12px;font-size:13.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ls-callout-body p{margin:0 0 10px;white-space:pre-wrap}
.ls-callout-body p:last-child{margin-bottom:0}
.ls-callout-body ul,.ls-callout-body ol{margin:0 0 10px;padding-left:22px}
.ls-md hr{margin:26px 0;border:0;border-top:1px solid var(--dsw-alias-border-l2);opacity:.85}
.ls-md a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px;word-break:break-all}
.ls-md a:hover{text-decoration-thickness:2px}
.ls-md strong{font-weight:650}
.ls-md em{font-style:italic}
.ls-md .ls-inline-code{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;font-size:12.5px;padding:1px 6px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);color:var(--dsw-alias-label-primary);white-space:break-spaces}
.ls-code{position:relative;margin:0 0 18px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-base);overflow:hidden;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.ls-code-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:4px;min-height:34px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-code-lang{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:10.5px;font-weight:700;letter-spacing:.04em;line-height:1}
.ls-code-lines{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-code-actions{margin-left:auto;display:flex;align-items:center;gap:4px}
.ls-code-action{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}
.ls-code-action:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ls-code-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ls-code-scroll{position:relative}
.ls-code-body{position:relative;display:flex;align-items:stretch;background:var(--dsw-alias-bg-base);overflow:auto;max-height:min(70vh,720px)}
.ls-code-body[data-collapsed]{max-height:180px;overflow-x:auto;overflow-y:hidden}
.ls-code-gutter{position:sticky;left:0;z-index:1;flex:none;box-sizing:content-box;padding:12px 10px 12px 14px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:12.5px;line-height:1.7;text-align:right;user-select:none}
.ls-code-line-no{display:block}
.ls-code-pre{flex:1 1 auto;min-width:0;margin:0;padding:12px 14px;overflow:visible;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-primary);tab-size:4;white-space:pre}
.ls-code-pre code{display:block;width:max-content;min-width:100%;font-family:inherit;font-size:inherit;white-space:pre}
.ls-code-fade{position:absolute;pointer-events:none;z-index:2;opacity:0;transition:opacity .15s ease}
.ls-code-fade-top{left:0;right:0;top:0;height:16px;background:linear-gradient(180deg,var(--dsw-alias-bg-base),transparent)}
.ls-code-fade-bottom{left:0;right:0;bottom:0;height:16px;background:linear-gradient(0deg,var(--dsw-alias-bg-base),transparent)}
.ls-code-fade-left{top:0;bottom:0;left:0;width:16px;background:linear-gradient(90deg,var(--dsw-alias-bg-base),transparent)}
.ls-code-fade-right{top:0;bottom:0;right:0;width:16px;background:linear-gradient(270deg,var(--dsw-alias-bg-base),transparent)}
.ls-code-scroll[data-collapsed] .ls-code-fade-bottom{height:56px;opacity:1}
.ls-code-scroll[data-shadow-top] .ls-code-fade-top,.ls-code-scroll[data-shadow-bottom] .ls-code-fade-bottom,.ls-code-scroll[data-shadow-left] .ls-code-fade-left,.ls-code-scroll[data-shadow-right] .ls-code-fade-right{opacity:1}
.ls-mermaid{margin:0 0 20px;padding:0;border:1px solid color-mix(in srgb,#8b5cf6 35%,var(--dsw-alias-border-l1));border-left:3px solid #8b5cf6;border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-bg-base) 22%,transparent);overflow:hidden;text-align:left}
.ls-mermaid-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid color-mix(in srgb,#8b5cf6 22%,var(--dsw-alias-border-l1));background:linear-gradient(90deg,color-mix(in srgb,#8b5cf6 13%,var(--dsw-alias-bg-layer-2)),color-mix(in srgb,#8b5cf6 5%,var(--dsw-alias-bg-layer-2)))}
.ls-mermaid-head-main{display:flex;align-items:center;gap:8px;min-width:0}
.ls-mermaid-badge{padding:1px 7px;border-radius:999px;background:#8b5cf6;color:#fff;font-size:10.5px;line-height:1.7;font-weight:600;letter-spacing:.02em}
.ls-mermaid-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-mermaid-toggle{height:24px;padding:0 8px;font-size:11.5px}
.ls-mermaid-svg{display:flex;justify-content:flex-start;padding:14px 16px;overflow:auto;background:var(--dsw-alias-bg-base);text-align:center}
.ls-mermaid-svg svg{flex:none;margin:0 auto;max-width:none;height:auto}
.ls-mermaid-svg svg foreignObject{overflow:visible}
.ls-mermaid-svg svg foreignObject div,
.ls-mermaid-svg svg .nodeLabel,
.ls-mermaid-svg svg .edgeLabel,
.ls-mermaid-svg svg .label{line-height:1.25 !important}
.ls-mermaid-source{padding:0;background:var(--dsw-alias-bg-base)}
.ls-mermaid-source .ls-code{margin:0;border:0;border-radius:0}
.ls-mermaid-loading{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 18px;padding:22px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px}
.ls-mermaid-error{margin:0 0 18px;padding:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1))}
.ls-mermaid-error-text{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.ls-mermaid-error-actions{display:flex;justify-content:flex-end;margin:8px 0 10px}
.ls-mermaid-error .ls-code{margin:0;text-align:left}
.ls-svg-figure{position:relative;margin:0 0 18px;padding:16px 16px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:#ffffff;box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);overflow-x:auto;text-align:center}
.ls-svg-canvas{display:flex;justify-content:center;min-width:min-content}
.ls-svg-canvas svg{display:block;width:100%;height:auto;max-width:100%}
.ls-svg-badge{position:absolute;top:8px;right:10px;z-index:1;padding:1px 7px;border:1px solid #e2e8f0;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:10px;line-height:1.6;letter-spacing:.02em}
.ls-svg-fallback{margin:0 0 18px;padding:14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.ls-svg-fallback-title{margin-bottom:4px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-svg-fallback-note{margin-bottom:8px;font-size:12px;line-height:1.6}
.ls-svg-fallback-raw{margin:0;max-height:200px;overflow:auto;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.ls-code .token.bold{font-weight:700}
.ls-code .token.italic{font-style:italic}
.ls-code .token.comment,.ls-code .token.prolog,.ls-code .token.doctype,.ls-code .token.cdata{color:#6A737D;font-style:italic}
.ls-code .token.punctuation{color:#5C6370}
.ls-code .token.property,.ls-code .token.tag,.ls-code .token.boolean,.ls-code .token.number,.ls-code .token.constant,.ls-code .token.symbol,.ls-code .token.deleted{color:#E45649}
.ls-code .token.number,.ls-code .token.boolean,.ls-code .token.constant,.ls-code .token.symbol{color:#986801}
.ls-code .token.selector,.ls-code .token.attr-name,.ls-code .token.string,.ls-code .token.char,.ls-code .token.builtin,.ls-code .token.inserted{color:#50A14F}
.ls-code .token.attr-name{color:#986801}
.ls-code .token.builtin{color:#E45649}
.ls-code .token.operator,.ls-code .token.entity,.ls-code .token.url{color:#0184BC}
.ls-code .token.atrule,.ls-code .token.attr-value,.ls-code .token.keyword{color:#A626A4}
.ls-code .token.function{color:#4078F2}
.ls-code .token.class-name{color:#B07D00}
.ls-code .token.regex{color:#986801}
.ls-code .token.important,.ls-code .token.variable{color:#E45649}
.ls-code .token.important{font-weight:700}
.ls-code .token.namespace{opacity:.7}
body[data-ds-dark-theme] .ls-code .token.comment,body[data-ds-dark-theme] .ls-code .token.prolog,body[data-ds-dark-theme] .ls-code .token.doctype,body[data-ds-dark-theme] .ls-code .token.cdata{color:#7F848E;font-style:italic}
body[data-ds-dark-theme] .ls-code .token.punctuation{color:#ABB2BF}
body[data-ds-dark-theme] .ls-code .token.property,body[data-ds-dark-theme] .ls-code .token.tag,body[data-ds-dark-theme] .ls-code .token.constant,body[data-ds-dark-theme] .ls-code .token.symbol,body[data-ds-dark-theme] .ls-code .token.deleted{color:#E06C75}
body[data-ds-dark-theme] .ls-code .token.number,body[data-ds-dark-theme] .ls-code .token.boolean,body[data-ds-dark-theme] .ls-code .token.attr-name{color:#D19A66}
body[data-ds-dark-theme] .ls-code .token.selector,body[data-ds-dark-theme] .ls-code .token.string,body[data-ds-dark-theme] .ls-code .token.char,body[data-ds-dark-theme] .ls-code .token.inserted,body[data-ds-dark-theme] .ls-code .token.regex{color:#98C379}
body[data-ds-dark-theme] .ls-code .token.builtin,body[data-ds-dark-theme] .ls-code .token.variable,body[data-ds-dark-theme] .ls-code .token.important{color:#E06C75}
body[data-ds-dark-theme] .ls-code .token.operator,body[data-ds-dark-theme] .ls-code .token.entity,body[data-ds-dark-theme] .ls-code .token.url{color:#56B6C2}
body[data-ds-dark-theme] .ls-code .token.atrule,body[data-ds-dark-theme] .ls-code .token.attr-value,body[data-ds-dark-theme] .ls-code .token.keyword{color:#C678DD}
body[data-ds-dark-theme] .ls-code .token.function{color:#61AFEF}
body[data-ds-dark-theme] .ls-code .token.class-name{color:#E5C07B}
body[data-ds-dark-theme] .ls-code .token.important{font-weight:700}
body[data-ds-dark-theme] .ls-code .token.namespace{opacity:.7}
.ls-table-wrap{margin:0 0 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow-x:auto;background:var(--dsw-alias-bg-base)}
.ls-table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.65}
.ls-table th,.ls-table td{padding:8px 12px;border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top}
.ls-table thead th{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:650;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ls-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 45%,transparent)}
.ls-table tr:last-child td{border-bottom:0}
.ls-table th:last-child,.ls-table td:last-child{border-right:0}
.ls-quiz-fold{margin-top:36px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ls-quiz-fold-head{display:flex;align-items:center;gap:10px;width:100%;padding:14px 18px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.4;text-align:left;cursor:pointer}
.ls-quiz-fold-head:hover{background:var(--dsw-alias-bg-layer-2)}
.ls-quiz-fold-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ls-quiz-fold-title{font-weight:600}
.ls-quiz-fold-meta{flex:none;padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.ls-quiz-fold-score{flex:none;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:1.6}
.ls-quiz-fold-chevron{margin-left:auto;display:inline-block;font-size:11px;color:var(--dsw-alias-label-secondary);transition:transform .15s ease}
.ls-quiz-fold-chevron[data-open]{transform:rotate(90deg)}
.ls-quiz-fold-body{padding:0 18px 18px;border-top:1px solid var(--dsw-alias-border-l1)}
.ls-quiz-fold-body .ls-quiz{margin-top:14px;padding:0;border:0;border-radius:0;background:transparent}
.ls-quiz-fold-body .ls-quiz-title{display:none}
.ls-quiz-fold-body .ls-quiz-head{margin-bottom:4px}
.ls-concepts-card{margin-top:24px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.ls-concepts-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ls-concepts-title{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.ls-concepts-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-concepts-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.ls-concept-chip{display:inline-flex;align-items:center;max-width:100%;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;word-break:break-word;cursor:default}
.ls-concept-chip:hover{border-color:var(--dsw-alias-brand-primary)}
.ls-quiz{margin-top:36px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.ls-quiz-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.ls-quiz-title{margin:0;font-size:16px;font-weight:600;line-height:1.4}
.ls-quiz-score{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.ls-quiz-score[data-good]{color:var(--dsw-alias-state-success-primary)}
.ls-quiz-score[data-bad]{color:var(--dsw-alias-state-error-primary)}
.ls-quiz-verdict{margin:0 0 6px;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.ls-quiz-hint{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-quiz-q{padding:14px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ls-quiz-q:first-of-type{border-top:0;padding-top:6px}
.ls-quiz-question{display:flex;gap:8px;margin:0 0 10px;font-size:14px;font-weight:600;line-height:1.65}
.ls-quiz-concepts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:-4px 0 10px 22px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-quiz-concepts-label{color:var(--dsw-alias-label-secondary)}
.ls-quiz-concept-chip{display:inline-flex;align-items:center;padding:1px 7px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-brand-primary);font-size:10.5px;line-height:1.6}
.ls-quiz-q-no{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ls-quiz-options{display:flex;flex-direction:column;gap:6px}
.ls-quiz-option{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;text-align:left;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.ls-quiz-option:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ls-quiz-option:disabled{cursor:default}
.ls-quiz-option[data-selected]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-base))}
.ls-quiz-option[data-correct]{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 11%,var(--dsw-alias-bg-base))}
.ls-quiz-option[data-wrong]{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,var(--dsw-alias-bg-base))}
.ls-quiz-option-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-top:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1}
.ls-quiz-option[data-selected] .ls-quiz-option-mark{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ls-quiz-option[data-correct] .ls-quiz-option-mark{border-color:transparent;background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}
.ls-quiz-option[data-wrong] .ls-quiz-option-mark{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.ls-quiz-option-text{min-width:0;word-break:break-word}
.ls-quiz-explain{margin-top:8px;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0 8px 8px 0;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ls-quiz-explain[data-correct]{border-left-color:var(--dsw-alias-state-success-primary)}
.ls-quiz-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:16px}
.ls-quiz-empty{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.ls-form{display:flex;flex-direction:column;gap:14px;max-width:640px}
.ls-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.ls-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ls-input,.ls-select,.ls-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.ls-input,.ls-select{height:34px;padding:0 10px}
.ls-select{padding-right:6px}
.ls-textarea{min-height:96px;padding:8px 10px;resize:vertical}
.ls-input:focus,.ls-select:focus,.ls-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ls-input::placeholder,.ls-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.ls-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.ls-form-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:2px}
.ls-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ls-hint[data-error]{color:var(--dsw-alias-state-error-primary)}
.ls-field-foot{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-banner[data-kind="warn"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-warn-primary)}
.ls-math-block{margin:0 0 16px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 42%,transparent);overflow-x:auto;overflow-y:hidden;text-align:center;color:var(--dsw-alias-label-primary)}
.ls-math-block .katex-display{margin:0}
.ls-math-block .katex{font-size:1.12em}
.ls-math-inline .katex{font-size:1em}
.ls-math-raw{display:inline-block;max-width:100%;padding:1px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.ls-math-block>.ls-math-raw{text-align:left}
.ls-tabs{flex:none;display:flex;align-items:center;gap:2px;padding:0 20px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.ls-tab{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer}
.ls-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.ls-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ls-tab[data-active]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.ls-tab:disabled{opacity:.55;cursor:not-allowed}
.ls-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:10.5px;font-weight:600;line-height:1}
.ls-graph{display:flex;flex-direction:column;gap:12px}
.ls-graph-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ls-graph-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:720px}
.ls-graph-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ls-graph-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-graph-legend-item{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ls-graph-legend-line{display:inline-block;width:22px;height:0;border-top:2px solid var(--dsw-alias-brand-primary)}
.ls-graph-legend-line[data-relation="related"]{border-top:1.5px solid var(--dsw-alias-label-secondary)}
.ls-graph-legend-line[data-relation="contrast"]{border-top:2px dashed var(--dsw-alias-state-warn-primary)}
.ls-graph-legend-dot{flex:none;width:9px;height:9px;border-radius:50%}
.ls-graph-canvas{position:relative;width:100%;height:clamp(520px,56vh,620px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.ls-graph-svg{display:block;width:100%;height:100%;font-family:inherit;touch-action:none;cursor:grab}
.ls-graph-svg:active{cursor:grabbing}
.ls-graph-svg text{font-family:inherit}
.ls-graph-viewport{will-change:transform}
.ls-graph-links{pointer-events:none}
.ls-graph-fallback-svg{cursor:default}
.ls-graph-node{cursor:pointer;outline:none}
.ls-graph-node:focus-visible .ls-graph-node-circle{stroke:var(--dsw-alias-brand-primary);stroke-width:3}
.ls-graph-node-circle{stroke:var(--dsw-alias-bg-base);stroke-width:2;transition:stroke .12s ease,stroke-width .12s ease}
.ls-graph-node:hover .ls-graph-node-circle,.ls-graph-node[data-highlight] .ls-graph-node-circle{stroke:var(--dsw-alias-brand-primary);stroke-width:2.5}
.ls-graph-node[data-selected] .ls-graph-node-circle{stroke:var(--dsw-alias-brand-primary);stroke-width:3}
.ls-graph-node-label{font-size:11px;fill:var(--dsw-alias-label-primary);pointer-events:none;stroke:var(--dsw-alias-bg-base);stroke-width:3;stroke-linejoin:round;paint-order:stroke fill}
.ls-graph-node[data-locked] .ls-graph-node-circle{stroke-dasharray:3 3;fill-opacity:.55;opacity:.8}
.ls-graph-node[data-locked] .ls-graph-node-label{fill:var(--dsw-alias-label-secondary)}
.ls-graph-node-lock{font-size:9px;fill:var(--dsw-alias-label-secondary);pointer-events:none}
.ls-graph-edge[data-locked]{stroke-dasharray:3 4;opacity:.32}
.ls-graph-canvas[data-hide-locked] .ls-graph-node[data-locked],.ls-graph-canvas[data-hide-locked] .ls-graph-edge[data-locked]{display:none}
.ls-graph-toggle{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;white-space:nowrap}
.ls-graph-toggle input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
.ls-graph-locked-text{color:var(--dsw-alias-label-secondary)}
.ls-graph-node[data-locked]:hover .ls-graph-node-circle{stroke:var(--dsw-alias-brand-primary)}
.ls-graph-edge{fill:none}
.ls-graph-edge[data-relation="prerequisite"]{stroke:var(--dsw-alias-brand-primary);stroke-width:1.6}
.ls-graph-edge[data-relation="related"]{stroke:var(--dsw-alias-label-secondary);stroke-width:1.1;opacity:.7}
.ls-graph-edge[data-relation="contrast"]{stroke:var(--dsw-alias-state-warn-primary);stroke-width:1.3;stroke-dasharray:5 4}
.ls-graph-edge[data-highlight]{stroke-width:2.4;opacity:1}
.ls-graph-node[data-dim],.ls-graph-edge[data-dim]{opacity:.25}
.ls-graph-arrow-head{fill:var(--dsw-alias-brand-primary)}
.ls-graph-engine-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);color:var(--dsw-alias-label-secondary);font-size:13px}
.ls-graph-tooltip{position:absolute;z-index:5;max-width:280px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-bg-base) 40%,transparent);pointer-events:none;font-size:12px;line-height:1.5}
.ls-graph-tooltip-title{margin-bottom:2px;font-weight:600;word-break:break-word}
.ls-graph-tooltip-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-graph-info{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.ls-graph-info-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ls-graph-info-title{margin:0;font-size:14px;font-weight:600;line-height:1.4;word-break:break-word}
.ls-graph-info-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ls-graph-info-label{flex:none;min-width:58px;color:var(--dsw-alias-label-secondary)}
.ls-graph-chip{display:inline-flex;align-items:center;max-width:100%;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1.5;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-graph-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ls-graph-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.ls-graph-loading{display:flex;align-items:center;gap:10px;padding:36px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:13px;color:var(--dsw-alias-label-secondary)}
.ls-graph-node[data-chapter="0"] .ls-graph-node-circle{fill:#5B8FF9}
.ls-graph-node[data-chapter="1"] .ls-graph-node-circle{fill:#2FB37E}
.ls-graph-node[data-chapter="2"] .ls-graph-node-circle{fill:#D9A400}
.ls-graph-node[data-chapter="3"] .ls-graph-node-circle{fill:#E8684A}
.ls-graph-node[data-chapter="4"] .ls-graph-node-circle{fill:#9270CA}
.ls-graph-node[data-chapter="5"] .ls-graph-node-circle{fill:#2F9FB8}
.ls-graph-node[data-chapter="6"] .ls-graph-node-circle{fill:#E07B2A}
.ls-graph-node[data-chapter="7"] .ls-graph-node-circle{fill:#269A99}
.ls-graph-legend-dot[data-chapter="0"]{background:#5B8FF9}
.ls-graph-legend-dot[data-chapter="1"]{background:#2FB37E}
.ls-graph-legend-dot[data-chapter="2"]{background:#D9A400}
.ls-graph-legend-dot[data-chapter="3"]{background:#E8684A}
.ls-graph-legend-dot[data-chapter="4"]{background:#9270CA}
.ls-graph-legend-dot[data-chapter="5"]{background:#2F9FB8}
.ls-graph-legend-dot[data-chapter="6"]{background:#E07B2A}
.ls-graph-legend-dot[data-chapter="7"]{background:#269A99}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="0"] .ls-graph-node-circle{fill:#7EA8FF}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="1"] .ls-graph-node-circle{fill:#5AD8A6}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="2"] .ls-graph-node-circle{fill:#F6C445}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="3"] .ls-graph-node-circle{fill:#FF8A6B}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="4"] .ls-graph-node-circle{fill:#B79BFF}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="5"] .ls-graph-node-circle{fill:#6DC8EC}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="6"] .ls-graph-node-circle{fill:#FFB870}
body[data-ds-dark-theme] .ls-graph-node[data-chapter="7"] .ls-graph-node-circle{fill:#4FD1C5}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="0"]{background:#7EA8FF}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="1"]{background:#5AD8A6}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="2"]{background:#F6C445}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="3"]{background:#FF8A6B}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="4"]{background:#B79BFF}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="5"]{background:#6DC8EC}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="6"]{background:#FFB870}
body[data-ds-dark-theme] .ls-graph-legend-dot[data-chapter="7"]{background:#4FD1C5}
.ls-review{display:flex;flex-direction:column;gap:16px}
.ls-review-stats{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ls-review-stats strong{color:var(--dsw-alias-label-primary);font-weight:600}
.ls-review-section{display:flex;flex-direction:column;gap:8px}
.ls-review-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ls-review-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.ls-review-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ls-review-title{font-size:13.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);word-break:break-word}
.ls-review-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-review-meta[data-overdue]{color:var(--dsw-alias-state-warn-primary)}
.ls-review-actions{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ls-review-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ls-review-next{margin-top:14px;padding:10px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,var(--dsw-alias-border-l1));border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-success-primary);font-size:12.5px;line-height:1.6}
.ls-review-concepts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}
/* Dark-mode refinements: host tokens already adapt, these lift the weakest surfaces. */
body[data-ds-dark-theme] .ls-code{box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-bg-base) 65%,transparent)}
body[data-ds-dark-theme] .ls-callout{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,var(--dsw-alias-bg-base))}
body[data-ds-dark-theme] .ls-callout-body{color:var(--dsw-alias-label-primary)}
body[data-ds-dark-theme] .ls-callout-label{color:var(--dsw-alias-label-primary)}
body[data-ds-dark-theme] .ls-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
body[data-ds-dark-theme] .ls-quiz-option[data-selected]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,var(--dsw-alias-bg-base));border-color:var(--dsw-alias-brand-primary)}
body[data-ds-dark-theme] .ls-quiz-option[data-correct]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,var(--dsw-alias-bg-base));border-color:var(--dsw-alias-state-success-primary)}
body[data-ds-dark-theme] .ls-quiz-option[data-wrong]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,var(--dsw-alias-bg-base));border-color:var(--dsw-alias-state-error-primary)}
body[data-ds-dark-theme] .ls-review-item{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,var(--dsw-alias-bg-base));border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ls-review-item[data-upcoming]{opacity:.7}
body[data-ds-dark-theme] .ls-graph-canvas{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,var(--dsw-alias-bg-base))}
body[data-ds-dark-theme] .ls-graph-info{background:var(--dsw-alias-bg-layer-2)}
body[data-ds-dark-theme] .ls-graph-node[data-dim]{opacity:.3}
body[data-ds-dark-theme] .ls-graph-edge[data-relation="related"]{stroke:var(--dsw-alias-label-primary);opacity:.7}
body[data-ds-dark-theme] .ls-graph-tooltip{box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent)}
body[data-ds-dark-theme] .ls-svg-figure{border-color:var(--dsw-alias-border-l2);box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-bg-base) 65%,transparent)}
body[data-ds-dark-theme] .ls-mermaid{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,var(--dsw-alias-bg-base));border-color:color-mix(in srgb,#8b5cf6 40%,var(--dsw-alias-border-l2));box-shadow:0 6px 20px rgba(0,0,0,.35)}
body[data-ds-dark-theme] .ls-md .ls-inline-code{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,transparent);border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ls-math-block{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 28%,transparent);border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ls-quiz-fold{border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ls-review-empty{border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ls-skeleton-card{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,var(--dsw-alias-bg-base))}
body[data-ds-dark-theme] .ls-placeholder{border-color:var(--dsw-alias-border-l2)}
@media (max-width:860px){.ls-body{flex-direction:column}.ls-sidebar{width:auto;flex:0 0 auto;max-height:42%}.ls-main{flex:1 1 auto}.ls-reader-inner{padding:22px 18px 48px}}
@media (prefers-reduced-motion:reduce){.ls-spinner{animation-duration:2.4s}.ls-skeleton-card::after{animation:none}.ls-progress-fill{transition:none}.ls-code-fade{transition:none}}
.ls-sel-toolbar{position:fixed;z-index:40;display:flex;align-items:center;gap:4px;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);max-width:calc(100vw - 16px)}
.ls-sel-concept{height:28px;max-width:190px;font-size:12px;padding:0 6px}
.ls-sel-btn{height:28px;padding:0 9px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ls-sel-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.ls-sel-btn-warn{color:var(--dsw-alias-state-warn-primary)}
.ls-concept-chip{display:inline-flex;align-items:center;gap:2px;padding:1px 4px 1px 2px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1)}
.ls-concept-chip-main{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1.5;padding:2px 6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}
.ls-concept-chip-main:hover{color:var(--dsw-alias-brand-primary)}
.ls-concept-flag{font-size:10px;line-height:1;padding:2px 4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary)}
.ls-concept-actions{display:inline-flex;align-items:center;gap:1px;margin-left:2px}
.ls-concept-mini{width:18px;height:18px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:1;cursor:pointer}
.ls-concept-mini:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-interact-overlay{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(2px)}
.ls-interact-panel{display:flex;flex-direction:column;width:min(760px,100%);max-height:82vh;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);overflow:hidden}
.ls-interact-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ls-interact-head-main{display:flex;align-items:center;gap:8px;min-width:0}
.ls-interact-title{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.ls-interact-concept{max-width:320px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-interact-selection{margin:10px 14px 0;padding:8px 10px;border-left:3px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:120px;overflow:auto}
.ls-interact-body{flex:1;min-height:80px;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.ls-interact-message{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-base)}
.ls-interact-question{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.ls-interact-loading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;padding:10px 2px}
.ls-interact-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.ls-interact-footer{display:flex;align-items:flex-end;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ls-interact-follow{display:flex;align-items:flex-end;gap:8px;width:100%}
.ls-interact-input{flex:1;min-height:40px;max-height:120px;resize:vertical;font-size:12.5px}
.ls-mastery-concept-flag{padding:1px 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:10px;line-height:1.4}
.ls-plan-section{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,var(--dsw-alias-border-l1))}
.ls-plan-list{display:flex;flex-direction:column;gap:6px}
.ls-plan-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.ls-plan-type{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.ls-plan-title{font-size:12.5px;font-weight:600;line-height:1.5}
.ls-plan-detail{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-cert-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-cert-card[data-eligible]{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,var(--dsw-alias-bg-layer-1))}
.ls-cert-title{font-size:13px;font-weight:600}
.ls-cert-meta{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.ls-cert-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ls-doubt-list{display:flex;flex-direction:column;gap:6px}
.ls-doubt-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px}
.ls-doubt-badge{padding:1px 6px;border-radius:999px;font-size:11px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary)}
.ls-doubt-badge[data-level="lost"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.ls-doubt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-doubt-score{flex:none;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.ls-wrongbook{display:flex;flex-direction:column;gap:14px}
.ls-wrongbook-group{display:flex;flex-direction:column;gap:8px}
.ls-wrongbook-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ls-wrongbook-group-title{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.ls-wrongbook-item{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-wrongbook-question{font-size:13px;font-weight:600;line-height:1.6}
.ls-wrongbook-option{display:flex;align-items:flex-start;gap:8px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;font-size:12.5px;line-height:1.55}
.ls-wrongbook-option[data-correct]{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,var(--dsw-alias-bg-layer-1))}
.ls-wrongbook-option[data-chosen]:not([data-correct]){border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1))}
.ls-wrongbook-option-mark{flex:none;width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);font-size:10px;font-weight:600}
.ls-wrongbook-option-text{flex:1;min-width:0}
.ls-wrongbook-tag{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-wrongbook-tag-wrong{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.ls-wrongbook-explain{display:flex;gap:8px;padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.ls-wrongbook-explain-label{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-wrongbook-concepts{display:flex;flex-wrap:wrap;gap:6px}
body[data-ds-dark-theme] .ls-sel-toolbar,body[data-ds-dark-theme] .ls-interact-panel{box-shadow:0 14px 40px rgba(0,0,0,.5)}
body[data-ds-dark-theme] .ls-interact-overlay{background:rgba(0,0,0,.55)}
body[data-ds-dark-theme] .ls-wrongbook-option[data-correct]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,var(--dsw-alias-bg-layer-1))}
body[data-ds-dark-theme] .ls-wrongbook-option[data-chosen]:not([data-correct]){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,var(--dsw-alias-bg-layer-1))}

.ls-annotation{cursor:pointer;border-radius:2px;background:rgba(250,204,21,.36);box-decoration-break:clone;-webkit-box-decoration-break:clone}
mark.ls-annotation[data-color="yellow"]{background:rgba(250,204,21,.38)}
mark.ls-annotation[data-color="green"]{background:rgba(74,222,128,.32)}
mark.ls-annotation[data-color="blue"]{background:rgba(96,165,250,.32)}
mark.ls-annotation[data-color="pink"]{background:rgba(244,114,182,.28)}
mark.ls-annotation[data-color="purple"]{background:rgba(167,139,250,.30)}
u.ls-annotation{text-decoration:none;background:transparent;border-bottom:2px solid #eab308}
u.ls-annotation[data-color="green"]{border-bottom-color:#22c55e}
u.ls-annotation[data-color="blue"]{border-bottom-color:#3b82f6}
u.ls-annotation[data-color="pink"]{border-bottom-color:#ec4899}
u.ls-annotation[data-color="purple"]{border-bottom-color:#8b5cf6}
.ls-annotation[data-has-note]::after{content:'•';font-size:10px;line-height:1;vertical-align:super;color:var(--dsw-alias-label-secondary);margin-left:1px}
.ls-sel-toolbar{flex-wrap:nowrap;max-width:min(920px,calc(100vw - 16px))}
@media (max-width:720px){.ls-sel-toolbar{flex-wrap:wrap}}
.ls-sel-sep{width:1px;height:18px;background:var(--dsw-alias-border-l1);margin:0 2px}
.ls-sel-color{width:58px}
.ls-ann-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(2px)}
.ls-ann-dialog{width:min(540px,100%);display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent)}
.ls-ann-dialog-title{margin:0;font-size:15px;font-weight:600}
.ls-ann-quote{padding:8px 10px;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65;white-space:pre-wrap;max-height:120px;overflow:auto}
.ls-ann-note-input{width:100%;box-sizing:border-box;resize:vertical;font-size:13px}
.ls-ann-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
.ls-ann-popover{position:fixed;z-index:45;width:min(380px,calc(100vw - 16px));display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 36px color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent)}
.ls-ann-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ls-ann-pop-title{font-size:13px;font-weight:600}
.ls-ann-pop-quote{padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:90px;overflow:auto}
.ls-ann-pop-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ls-ann-pop-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ls-ann-swatches{display:flex;gap:5px}
.ls-ann-swatch{width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;padding:0}
.ls-ann-swatch[data-color="yellow"]{background:#facc15}
.ls-ann-swatch[data-color="green"]{background:#4ade80}
.ls-ann-swatch[data-color="blue"]{background:#60a5fa}
.ls-ann-swatch[data-color="pink"]{background:#f472b6}
.ls-ann-swatch[data-color="purple"]{background:#a78bfa}
.ls-ann-swatch[data-active]{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--dsw-alias-brand-primary)}
.ls-ann-style-toggle{display:flex;gap:4px;margin-left:auto}
.ls-ann-style-toggle .ls-btn[data-active]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ls-ann-pop-note{width:100%;box-sizing:border-box;resize:vertical;font-size:12.5px}
.ls-ann-pop-actions{display:flex;justify-content:space-between;gap:8px}
body[data-ds-dark-theme] mark.ls-annotation[data-color="yellow"]{background:rgba(250,204,21,.26)}
body[data-ds-dark-theme] mark.ls-annotation[data-color="green"]{background:rgba(74,222,128,.22)}
body[data-ds-dark-theme] mark.ls-annotation[data-color="blue"]{background:rgba(96,165,250,.22)}
body[data-ds-dark-theme] mark.ls-annotation[data-color="pink"]{background:rgba(244,114,182,.20)}
body[data-ds-dark-theme] mark.ls-annotation[data-color="purple"]{background:rgba(167,139,250,.22)}
body[data-ds-dark-theme] .ls-ann-popover,body[data-ds-dark-theme] .ls-ann-dialog{box-shadow:0 14px 44px rgba(0,0,0,.55)}

.ls-interact-head-actions{display:flex;align-items:center;gap:6px;flex:none}
.ls-interact-history{display:flex;flex-direction:column;gap:6px;padding-bottom:8px;border-bottom:1px dashed var(--dsw-alias-border-l1);margin-bottom:4px}
.ls-interact-history-item{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer}
.ls-interact-history-item:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ls-interact-history-kind{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.ls-interact-history-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ls-interact-history-selection{font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-interact-history-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-records{display:flex;flex-direction:column;gap:16px}
.ls-records-section{display:flex;flex-direction:column;gap:8px}
.ls-records-title{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.ls-record-item{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-record-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ls-record-kind{padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:1.6}
.ls-record-chapter{font-size:12px;font-weight:600;line-height:1.5}
.ls-record-concept{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-record-time{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.ls-record-selection{padding:6px 9px;border-left:3px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:110px;overflow:auto}
.ls-record-answer{margin-top:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.ls-record-ann{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.ls-record-ann-color{flex:none;width:14px;height:14px;border-radius:50%;margin-top:2px;background:#facc15;border:1px solid var(--dsw-alias-border-l2)}
.ls-record-ann-color[data-color="green"]{background:#4ade80}
.ls-record-ann-color[data-color="blue"]{background:#60a5fa}
.ls-record-ann-color[data-color="pink"]{background:#f472b6}
.ls-record-ann-color[data-color="purple"]{background:#a78bfa}
.ls-record-ann-style{flex:none;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-record-ann-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ls-record-ann-quote{font-size:12px;line-height:1.6;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.ls-record-ann-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-brand-primary)}
.ls-record-ann-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
body[data-ds-dark-theme] .ls-record-answer{background:var(--dsw-alias-bg-layer-2)}

.ls-ann-tools{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.ls-ann-colors{display:inline-flex;align-items:center;gap:3px;padding-right:2px}
.ls-ann-dot{width:16px;height:16px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);padding:0;cursor:pointer;box-shadow:none}
.ls-ann-dot[data-color="yellow"]{background:#facc15}
.ls-ann-dot[data-color="green"]{background:#4ade80}
.ls-ann-dot[data-color="blue"]{background:#60a5fa}
.ls-ann-dot[data-color="pink"]{background:#f472b6}
.ls-ann-dot[data-color="purple"]{background:#a78bfa}
.ls-ann-dot[data-active]{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 3px var(--dsw-alias-brand-primary)}
.ls-ann-icon-btn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1}
.ls-ann-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ls-ann-icon-btn:disabled{opacity:.5;cursor:not-allowed}
.ls-ann-icon-btn[data-active]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ls-ann-icon-primary{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
.ls-ann-icon-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-1))}
.ls-ann-icon-danger{color:var(--dsw-alias-state-error-primary)}
.ls-ann-icon-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-state-error-primary)}
.ls-record-ann-style{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-secondary)}

.ls-ann-notes{display:flex;flex-direction:column;gap:6px;max-height:170px;overflow:auto}
.ls-ann-notes-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.ls-ann-note-item{display:flex;align-items:flex-start;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
.ls-ann-note-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ls-ann-note-text{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.ls-ann-note-time{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.ls-ann-note-del{flex:none;width:22px;height:22px}
.ls-ann-note-add{display:flex;align-items:flex-end;gap:6px}
.ls-ann-note-add .ls-ann-pop-note{flex:1;min-width:0}
.ls-ann-plus{font-size:19px;line-height:1;font-weight:500}

.ls-stage-list{display:flex;flex-direction:column;gap:8px}
.ls-stage-card{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-stage-card[data-status="passed"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,var(--dsw-alias-bg-layer-1))}
.ls-stage-card[data-status="failed"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1))}
.ls-stage-card[data-status="locked"]{opacity:.72}
.ls-stage-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ls-stage-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ls-stage-title{font-size:13px;font-weight:600;line-height:1.5}
.ls-stage-badge{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.ls-stage-card[data-status="passed"] .ls-stage-badge{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-stage-card[data-status="failed"] .ls-stage-badge{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.ls-stage-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-stage-chapters{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-assess-overlay{position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(2px)}
.ls-assess-panel{display:flex;flex-direction:column;width:min(760px,100%);max-height:86vh;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);overflow:hidden}
.ls-assess-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ls-assess-head-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-assess-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.ls-assess-range{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-assess-body{flex:1;overflow:auto;padding:14px 16px}
.ls-assess-loading{display:flex;align-items:center;gap:8px;padding:16px 2px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.ls-assess-error{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.ls-assess-result{display:flex;flex-direction:column;gap:4px;padding:10px 12px;margin-bottom:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1))}
.ls-assess-result[data-passed]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,var(--dsw-alias-bg-layer-1))}
.ls-assess-result-score{font-size:18px;font-weight:600;line-height:1.3}
.ls-assess-result-text{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.ls-assess-result-unlock{font-size:12px;font-weight:600;color:var(--dsw-alias-state-success-primary)}
.ls-assess-submit-error{margin:8px 0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
body[data-ds-dark-theme] .ls-assess-overlay{background:rgba(0,0,0,.55)}

.ls-wrongbook-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.ls-wrongbook-resolved{flex:none;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:1.6}
.ls-wrongbook-item[data-resolved]{opacity:.78;border-style:dashed}
.ls-wrongbook-retrain-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-wrongbook-actions{display:flex;justify-content:flex-end;gap:6px}
.ls-retrain-overlay{position:fixed;inset:0;z-index:56;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(2px)}
.ls-retrain-panel{display:flex;flex-direction:column;width:min(700px,100%);max-height:86vh;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);overflow:hidden}
.ls-retrain-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ls-retrain-head-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-retrain-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.ls-retrain-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-retrain-body{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.ls-retrain-loading{display:flex;align-items:center;gap:8px;padding:14px 2px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.ls-retrain-error{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.ls-retrain-question{display:flex;flex-direction:column;gap:8px}
.ls-retrain-stem{font-size:14px;font-weight:600;line-height:1.7}
.ls-retrain-concepts{display:flex;flex-wrap:wrap;gap:6px}
.ls-retrain-options{display:flex;flex-direction:column;gap:6px}
.ls-retrain-option{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;line-height:1.6;text-align:left;cursor:pointer}
.ls-retrain-option:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ls-retrain-option[data-selected]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1))}
.ls-retrain-option[data-correct]{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,var(--dsw-alias-bg-layer-1))}
.ls-retrain-option[data-wrong]{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}
.ls-retrain-option:disabled{cursor:default}
.ls-retrain-option-mark{flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);font-size:11px;font-weight:600}
.ls-retrain-option-text{flex:1;min-width:0}
.ls-retrain-tag{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.ls-retrain-tag-wrong{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.ls-retrain-result{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1))}
.ls-retrain-result[data-correct]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,var(--dsw-alias-bg-layer-1))}
.ls-retrain-result-title{font-size:13px;font-weight:600}
.ls-retrain-explain{display:flex;gap:8px;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.ls-retrain-explain-label{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-retrain-stats{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ls-retrain-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.ls-retrain-nav{display:flex;gap:6px}
.ls-retrain-actions{display:flex;gap:6px}
body[data-ds-dark-theme] .ls-retrain-overlay{background:rgba(0,0,0,.55)}

.ls-plan{display:flex;flex-direction:column;gap:14px}
.ls-plan-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-plan-summary-main{display:flex;align-items:baseline;gap:6px}
.ls-plan-summary-number{font-size:24px;font-weight:600;line-height:1}
.ls-plan-summary-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-plan-summary-meta{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-plan-summary .ls-btn{margin-left:auto}
.ls-plan-reminder{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,var(--dsw-alias-bg-layer-1));font-size:12.5px;color:var(--dsw-alias-state-warn-primary)}
.ls-plan-reminder-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none}
.ls-plan-form{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ls-plan-form-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px}
.ls-plan-form-actions{display:flex;justify-content:flex-end}
.ls-plan-group{display:flex;flex-direction:column;gap:6px}
.ls-plan-group-title{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ls-plan-task{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.ls-plan-task[data-done]{opacity:.7}
.ls-plan-check{margin-top:2px;flex:none;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.ls-plan-task-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ls-plan-task-title{font-size:13px;font-weight:600;line-height:1.5}
.ls-plan-task[data-done] .ls-plan-task-title{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}
.ls-plan-task-detail{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-plan-task-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.ls-plan-task-date{flex:none;width:172px;height:30px;font-size:11.5px;padding:0 6px}
.ls-plan-suggestions{display:flex;flex-direction:column;gap:6px}
.ls-plan-suggestion-list{display:flex;flex-direction:column;gap:6px}
.ls-plan-suggestion{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.ls-plan-suggestion-type{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.ls-plan-suggestion-main{flex:1;min-width:0}
.ls-plan-suggestion-title{font-size:12.5px;font-weight:600;line-height:1.5}
.ls-plan-suggestion-detail{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
@media (max-width:760px){.ls-plan-form-grid{grid-template-columns:1fr}.ls-plan-task{flex-wrap:wrap}.ls-plan-task-date{width:100%}}

.ls-sidebar-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ls-sidebar-toggle{width:24px;height:24px;min-width:24px;padding:0;font-size:15px;line-height:1}

`;

    /* ---------------------------------------------------------------- */
    /* Icons                                                             */
    /* ---------------------------------------------------------------- */

    function SpaceIcon({ size, active }) {
      const dimension = Number(size) > 0 ? Number(size) : 16;
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
          style: { color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
        },
        h('path', {
          d: 'M2.5 3.25A1.25 1.25 0 0 1 3.75 2H8v11H3.75A1.25 1.25 0 0 1 2.5 11.75v-8.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.5 3.25A1.25 1.25 0 0 0 12.25 2H8v11h4.25a1.25 1.25 0 0 0 1.25-1.25v-8.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
      );
    }

    function BookIcon({ size }) {
      const dimension = Number(size) > 0 ? Number(size) : 40;
      return h(
        'svg',
        {
          className: 'ls-empty-icon',
          width: dimension,
          height: dimension,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M3.5 5.2A2.2 2.2 0 0 1 5.7 3H11v17H5.7a2.2 2.2 0 0 1-2.2-2.2V5.2Z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M20.5 5.2A2.2 2.2 0 0 0 18.3 3H13v17h5.3a2.2 2.2 0 0 0 2.2-2.2V5.2Z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
      );
    }

    function PlusIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M8 3.2v9.6M3.2 8h9.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      );
    }

    function RefreshIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M13.4 7.2A5.5 5.5 0 1 0 13.5 9.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.4 3.4v3.9H9.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function TrashIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M3.4 4.6h9.2M6.4 4.4V3.5a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v.9M4.6 4.6l.5 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-8M6.8 7v4M9.2 7v4',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function LockIcon({ size }) {
      const dimension = Number.isFinite(Number(size)) ? Number(size) : 14;
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('rect', {
          x: '3.4',
          y: '7',
          width: '9.2',
          height: '6.2',
          rx: '1.2',
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    function HighlightIcon({ size }) {
      const dimension = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M9.2 14.8 6 18v-3.6l9.4-9.4a2.2 2.2 0 0 1 3.1 0l.5.5a2.2 2.2 0 0 1 0 3.1L9.2 18', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M13.6 5.6l4.8 4.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M4 21h16', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      );
    }

    function UnderlineIcon({ size }) {
      const dimension = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M7 4v6a5 5 0 0 0 10 0V4', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M5 20h14', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }),
      );
    }

    function NoteIcon({ size }) {
      const dimension = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M20 4H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2v4l4-4h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 9h8M8 12.5h5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      );
    }

    function TrashIcon({ size }) {
      const dimension = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M4 7h16M9 7V5h6v2M6.5 7l.8 12.2a1.8 1.8 0 0 0 1.8 1.8h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M10 11v5M14 11v5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    function CheckIcon({ size }) {
      const dimension = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M5 12.5l4.5 4.5L19 7', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Small presentational components                                   */
    /* ---------------------------------------------------------------- */

    function Spinner({ tone }) {
      return h('span', { className: 'ls-spinner', 'data-tone': tone, role: 'status', 'aria-label': '处理中' });
    }

    function ProgressBar({ value, total, tone }) {
      const max = Math.max(0, Math.round(Number(total) || 0));
      const current = Math.max(0, Math.min(Math.round(Number(value) || 0), max));
      const percent = max === 0 ? 0 : Math.round((current / max) * 100);
      return h(
        'div',
        {
          className: 'ls-progress',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': max,
          'aria-valuenow': current,
          'aria-label': `进度 ${current} / ${max}`,
        },
        h('div', { className: 'ls-progress-fill', 'data-tone': tone, style: { width: `${percent}%` } }),
      );
    }

    function Tag({ children, tone }) {
      const toneClass = tone === 'domain' ? ' ls-tag-domain' : tone === 'success' ? ' ls-tag-success' : tone === 'warn' ? ' ls-tag-warn' : tone === 'idle' ? ' ls-tag-idle' : ' ls-tag-level';
      return h('span', { className: `ls-tag${toneClass}` }, children);
    }

    function NoticeBanner({ notice, onClose }) {
      if (notice === null || notice === undefined) return null;
      return h(
        'div',
        { className: 'ls-banner', 'data-kind': notice.kind || 'info', role: notice.kind === 'error' ? 'alert' : 'status' },
        h('span', { className: 'ls-banner-text' }, notice.text),
        h('button', { type: 'button', className: 'ls-banner-close', onClick: onClose, 'aria-label': '关闭提示' }, '×'),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Generation status bar                                             */
    /* ---------------------------------------------------------------- */

    function jobStepIcon(status) {
      if (status === 'running') return h(Spinner, { tone: 'sm' });
      const glyph =
        status === 'done'
          ? '✓'
          : status === 'failed'
            ? '!'
            : status === 'skipped'
              ? '—'
              : status === 'cancelled'
                ? '×'
                : '·';
      return h(
        'span',
        { className: 'ls-gen-step-glyph', 'data-status': status, 'aria-hidden': true },
        glyph,
      );
    }

    function GenerationStatus({ state, showCourseTitle, onCancel, onRetry, onContinue, onDismiss }) {
      if (state === null || state === undefined) return null;
      const total = Math.max(1, Number(state.total) || 1);
      const done = Math.min(Math.max(0, Number(state.done) || 0), total);
      const failed = !state.running && Number.isInteger(state.failedIndex);
      const currentNumber = Number.isInteger(state.currentIndex) ? state.currentIndex + 1 : null;
      const indices = Array.isArray(state.indices) ? state.indices : [];
      const title = state.currentTitle ? `：${state.currentTitle}` : '';
      const coursePrefix = showCourseTitle && state.courseTitle ? `《${state.courseTitle}》` : '';
      const job =
        state.job !== null && state.job !== undefined && Array.isArray(state.job.steps) && state.job.steps.length > 0
          ? state.job
          : null;
      const steps = job !== null ? job.steps : [];
      const completedSteps = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length;
      const warnings = job !== null && Array.isArray(job.warnings) ? job.warnings : [];
      const topText = failed
        ? `${coursePrefix}第 ${state.failedIndex + 1} 章生成失败：${state.error || '未知错误'}`
        : state.cancelRequested
          ? `${coursePrefix}正在取消第 ${currentNumber} 章生成…`
          : `${coursePrefix}正在生成第 ${currentNumber} 章${title}（${done} / ${total}）`;

      return h(
        'div',
        { className: 'ls-gen-bar', 'data-failed': failed ? '' : undefined, role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'ls-gen-top' },
          failed ? null : h(Spinner, null),
          h('div', { className: 'ls-gen-text' }, topText),
          h(
            'div',
            { className: 'ls-gen-actions' },
            state.running
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn ls-btn-sm',
                    onClick: onCancel,
                    disabled: state.cancelRequested,
                    title: '取消当前生成任务',
                  },
                  state.cancelRequested ? '正在取消…' : '取消生成',
                )
              : null,
            failed
              ? h(
                  'button',
                  { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: onRetry },
                  '重试该章',
                )
              : null,
            failed && Number.isInteger(state.failedStep) && state.failedStep < indices.length - 1
              ? h('button', { type: 'button', className: 'ls-btn ls-btn-sm', onClick: onContinue }, '继续后续章节')
              : null,
            failed
              ? h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onDismiss }, '关闭')
              : null,
          ),
        ),
        state.running || failed
          ? h(ProgressBar, { value: done, total, tone: failed ? 'error' : undefined })
          : null,
        job !== null
          ? h(
              'div',
              { className: 'ls-gen-steps' },
              h(
                'div',
                { className: 'ls-gen-steps-head' },
                h('span', null, '生成步骤'),
                h(
                  'span',
                  { className: 'ls-gen-steps-count' },
                  job.status === 'queued' ? '排队中' : `${completedSteps} / ${steps.length}`,
                ),
              ),
              h(
                'ul',
                { className: 'ls-gen-step-list' },
                steps.map((step) =>
                  h(
                    'li',
                    {
                      key: step.key || step.label,
                      className: 'ls-gen-step',
                      'data-status': step.status,
                      'data-current': job.currentStep === step.key ? '' : undefined,
                      title: step.detail || step.label,
                    },
                    jobStepIcon(step.status),
                    h('span', { className: 'ls-gen-step-label' }, step.label || step.key),
                    step.status === 'running' && step.detail !== ''
                      ? h('span', { className: 'ls-gen-step-detail' }, step.detail)
                      : step.status === 'failed' && step.detail !== ''
                        ? h('span', { className: 'ls-gen-step-detail' }, step.detail)
                        : null,
                  ),
                ),
              ),
              warnings.length > 0
                ? h(
                    'div',
                    { className: 'ls-gen-warnings', title: warnings.join('\n') },
                    h('span', { className: 'ls-gen-warnings-icon', 'aria-hidden': true }, 'ⓘ'),
                    h(
                      'span',
                      null,
                      `${warnings.slice(0, 2).join('；')}${warnings.length > 2 ? `（等 ${warnings.length} 条提示）` : ''}`,
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    /* ---------------------------------------------------------------- */
    /* Create course panel                                               */
    /* ---------------------------------------------------------------- */

    function CreateCoursePanel({ onCreated, onCancel }) {
      const mountedRef = React.useRef(true);
      const [topic, setTopic] = React.useState('');
      const [domain, setDomain] = React.useState('general');
      const [level, setLevel] = React.useState('beginner');
      const [chapterCount, setChapterCount] = React.useState(String(DEFAULT_CHAPTERS));
      const [initialUnlocked, setInitialUnlocked] = React.useState(
        String(Math.min(DEFAULT_INITIAL_UNLOCKED, DEFAULT_CHAPTERS)),
      );
      const [masteryThreshold, setMasteryThreshold] = React.useState(String(DEFAULT_MASTERY_THRESHOLD));
      const [stageSize, setStageSize] = React.useState('3');
      const [notes, setNotes] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [topicError, setTopicError] = React.useState('');

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const submit = async (event) => {
        if (event !== undefined && event !== null) event.preventDefault();
        if (busy) return;
        const trimmedTopic = topic.trim();
        if (trimmedTopic.length < 2) {
          setTopicError('请填写课程主题（至少 2 个字）');
          return;
        }
        setTopicError('');
        setError('');
        setBusy(true);
        try {
          const parsedCount = Number(chapterCount);
          const safeCount = Number.isFinite(parsedCount)
            ? Math.min(MAX_CHAPTERS, Math.max(MIN_CHAPTERS, Math.round(parsedCount)))
            : DEFAULT_CHAPTERS;
          const requestedUnlocked = Number(initialUnlocked);
          const safeUnlocked = Number.isFinite(requestedUnlocked)
            ? Math.min(safeCount, Math.max(1, Math.round(requestedUnlocked)))
            : Math.min(DEFAULT_INITIAL_UNLOCKED, safeCount);
          const requestedThreshold = Number(masteryThreshold);
          const safeThreshold = Number.isFinite(requestedThreshold)
            ? Math.min(100, Math.max(30, Math.round(requestedThreshold)))
            : DEFAULT_MASTERY_THRESHOLD;
          const requestedStageSize = Number(stageSize);
          const safeStageSize = Number.isFinite(requestedStageSize)
            ? Math.min(safeCount, Math.max(2, Math.round(requestedStageSize)))
            : Math.min(3, safeCount);
          const result = await callApi('outline', {
            topic: trimmedTopic,
            domain,
            level,
            chapterCount: safeCount,
            initialUnlocked: safeUnlocked,
            masteryThreshold: safeThreshold,
            stageSize: safeStageSize,
            stageThreshold: safeThreshold,
            notes: notes.trim().slice(0, MAX_NOTES),
          });
          if (!mountedRef.current) return;
          if (result.course === null || result.course === undefined) {
            throw new Error('宿主没有返回课程数据，请重试');
          }
          onCreated(result.course);
        } catch (failure) {
          if (mountedRef.current) setError(failure && failure.message ? failure.message : '生成大纲失败，请重试');
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      };

      const parsedChapterCount = Number(chapterCount);
      const safeChapterCount = Number.isFinite(parsedChapterCount)
        ? Math.min(MAX_CHAPTERS, Math.max(MIN_CHAPTERS, Math.round(parsedChapterCount)))
        : DEFAULT_CHAPTERS;

      return h(
        'div',
        { className: 'ls-panel' },
        h(
          'div',
          { className: 'ls-detail-head' },
          h(
            'div',
            { className: 'ls-detail-title-row' },
            h(
              'div',
              { className: 'ls-detail-title-wrap' },
              h('h2', { className: 'ls-detail-title' }, '新建课程'),
              h('p', { className: 'ls-detail-sub' }, 'AI 会先设计课程大纲；确认大纲后再逐章生成正文。'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-ghost',
                onClick: onCancel,
                disabled: busy,
              },
              '取消',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ls-panel-scroll' },
          h(
            'form',
            { className: 'ls-form', onSubmit: submit },
            h(
              'div',
              { className: 'ls-field' },
              h('label', { className: 'ls-label', htmlFor: 'ls-topic' }, '课程主题 *'),
              h('input', {
                id: 'ls-topic',
                className: 'ls-input',
                type: 'text',
                value: topic,
                maxLength: 200,
                placeholder: '例如：扩散模型入门',
                disabled: busy,
                onChange: (event) => {
                  setTopic(event.target.value);
                  if (topicError !== '') setTopicError('');
                },
              }),
              topicError !== '' ? h('span', { className: 'ls-hint', 'data-error': '' }, topicError) : null,
            ),
            h(
              'div',
              { className: 'ls-form-grid' },
              h(
                'div',
                { className: 'ls-field' },
                h('label', { className: 'ls-label', htmlFor: 'ls-domain' }, '领域'),
                h(
                  'select',
                  {
                    id: 'ls-domain',
                    className: 'ls-select',
                    value: domain,
                    disabled: busy,
                    onChange: (event) => setDomain(event.target.value),
                  },
                  DOMAIN_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                ),
              ),
              h(
                'div',
                { className: 'ls-field' },
                h('label', { className: 'ls-label', htmlFor: 'ls-level' }, '难度'),
                h(
                  'select',
                  {
                    id: 'ls-level',
                    className: 'ls-select',
                    value: level,
                    disabled: busy,
                    onChange: (event) => setLevel(event.target.value),
                  },
                  LEVEL_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                ),
              ),
              h(
                'div',
                { className: 'ls-field' },
                h('label', { className: 'ls-label', htmlFor: 'ls-count' }, '章节数'),
                h('input', {
                  id: 'ls-count',
                  className: 'ls-input',
                  type: 'number',
                  min: MIN_CHAPTERS,
                  max: MAX_CHAPTERS,
                  step: 1,
                  value: chapterCount,
                  disabled: busy,
                  onChange: (event) => {
                    const next = event.target.value;
                    setChapterCount(next);
                    const numeric = Number(next);
                    if (Number.isFinite(numeric)) {
                      const bounded = Math.min(MAX_CHAPTERS, Math.max(MIN_CHAPTERS, Math.round(numeric)));
                      setInitialUnlocked((previous) => {
                        const value = Number(previous);
                        const current = Number.isFinite(value) ? Math.round(value) : Math.min(DEFAULT_INITIAL_UNLOCKED, bounded);
                        return String(Math.min(bounded, Math.max(1, current)));
                      });
                    }
                  },
                }),
                h('span', { className: 'ls-hint' }, `${MIN_CHAPTERS}–${MAX_CHAPTERS} 章，建议 6 章左右`),
              ),
              h(
                'div',
                { className: 'ls-field' },
                h('label', { className: 'ls-label', htmlFor: 'ls-initial-unlocked' }, '初始解锁章节数'),
                h('input', {
                  id: 'ls-initial-unlocked',
                  className: 'ls-input',
                  type: 'number',
                  min: 1,
                  max: safeChapterCount,
                  step: 1,
                  value: initialUnlocked,
                  disabled: busy,
                  onChange: (event) => setInitialUnlocked(event.target.value),
                  onBlur: () => {
                    const value = Number(initialUnlocked);
                    const bounded = Number.isFinite(value)
                      ? Math.min(safeChapterCount, Math.max(1, Math.round(value)))
                      : Math.min(DEFAULT_INITIAL_UNLOCKED, safeChapterCount);
                    setInitialUnlocked(String(bounded));
                  },
                }),
                h('span', { className: 'ls-hint' }, `1–${safeChapterCount} 章，默认前 ${Math.min(DEFAULT_INITIAL_UNLOCKED, safeChapterCount)} 章`),
              ),
              h(
                'div',
                { className: 'ls-field' },
                h('label', { className: 'ls-label', htmlFor: 'ls-stage-size' }, '每阶段章节数'),
                h('input', {
                  id: 'ls-stage-size',
                  className: 'ls-input',
                  type: 'number',
                  min: 2,
                  max: safeChapterCount,
                  step: 1,
                  value: stageSize,
                  disabled: busy,
                  onChange: (event) => setStageSize(event.target.value),
                  onBlur: () => {
                    const value = Number(stageSize);
                    const bounded = Number.isFinite(value)
                      ? Math.min(safeChapterCount, Math.max(2, Math.round(value)))
                      : Math.min(3, safeChapterCount);
                    setStageSize(String(bounded));
                  },
                }),
                h('span', { className: 'ls-hint' }, '每 N 章一个阶段；通过阶段测评才能解锁下一阶段'),
              ),
              h(
                'div',
                { className: 'ls-field' },
                h('label', { className: 'ls-label', htmlFor: 'ls-mastery-threshold' }, '掌握度门槛'),
                h(
                  'select',
                  {
                    id: 'ls-mastery-threshold',
                    className: 'ls-select',
                    value: masteryThreshold,
                    disabled: busy,
                    onChange: (event) => setMasteryThreshold(event.target.value),
                  },
                  MASTERY_THRESHOLD_OPTIONS.map((value) =>
                    h('option', { key: value, value: String(value) }, `${value}%`),
                  ),
                ),
                h('span', { className: 'ls-hint' }, '上一章完成且测验/概念掌握达到该值后解锁下一章'),
              ),
            ),
            h(
              'div',
              { className: 'ls-field' },
              h('label', { className: 'ls-label', htmlFor: 'ls-notes' }, '补充要求（可选）'),
              h('textarea', {
                id: 'ls-notes',
                className: 'ls-textarea',
                value: notes,
                maxLength: MAX_NOTES,
                placeholder: '例如：多举生活中的例子，避免公式推导；最后两章讲工程实践。',
                disabled: busy,
                onChange: (event) => setNotes(event.target.value),
              }),
              h(
                'div',
                { className: 'ls-field-foot' },
                h('span', { className: 'ls-hint' }, '生成大纲通常需要 10–60 秒'),
                h('span', { className: 'ls-hint' }, `${notes.length} / ${MAX_NOTES}`),
              ),
            ),
            error !== '' ? h(NoticeBanner, { notice: { kind: 'error', text: error }, onClose: () => setError('') }) : null,
            h(
              'div',
              { className: 'ls-form-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn',
                  onClick: onCancel,
                  disabled: busy,
                },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'submit',
                  className: 'ls-btn ls-btn-primary',
                  disabled: busy || topic.trim().length < 2,
                },
                busy ? h(Spinner, null) : null,
                busy ? '正在设计大纲…' : '生成大纲',
              ),
            ),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Course detail pane                                                */
    /* ---------------------------------------------------------------- */

    /* ---------------------------------------------------------------- */
    /* Knowledge graph                                                   */
    /* ---------------------------------------------------------------- */

    const D3_JS_SRC = '/learning-space/vendor/d3/d3.v7.min.js';
    const D3_READY_EVENT = 'learning-space:d3-ready';
    let d3ScriptNode = null;
    let d3LoadTimer = 0;
    const d3Runtime = { promise: null, status: 'idle' };

    function getD3() {
      try {
        if (typeof window === 'undefined') return null;
        const d3 = window.d3;
        return d3 !== null &&
          d3 !== undefined &&
          typeof d3.forceSimulation === 'function' &&
          typeof d3.zoom === 'function' &&
          typeof d3.drag === 'function'
          ? d3
          : null;
      } catch (error) {
        return null;
      }
    }

    /** Remove the lazily injected d3 script (plugin disposal / retry). */
    function disposeD3Assets() {
      d3Runtime.promise = null;
      d3Runtime.status = 'idle';
      if (d3LoadTimer !== 0) {
        clearTimeout(d3LoadTimer);
        d3LoadTimer = 0;
      }
      if (d3ScriptNode !== null) {
        try {
          d3ScriptNode.remove();
        } catch (error) {
          /* already detached */
        }
        d3ScriptNode = null;
      }
    }

    /** Load the vendored d3 v7 UMD bundle once for the graph panel. */
    function loadD3() {
      const existing = getD3();
      if (existing !== null) return Promise.resolve(existing);
      if (d3Runtime.promise !== null) return d3Runtime.promise;
      if (d3Runtime.status === 'failed') return Promise.reject(new Error('图谱引擎加载失败，请重试'));

      d3Runtime.status = 'loading';
      d3Runtime.promise = new Promise((resolve, reject) => {
        if (typeof document === 'undefined' || document.head === null) {
          d3Runtime.status = 'failed';
          d3Runtime.promise = null;
          reject(new Error('当前环境不支持图谱渲染'));
          return;
        }
        const clearLoadTimer = () => {
          if (d3LoadTimer !== 0) {
            clearTimeout(d3LoadTimer);
            d3LoadTimer = 0;
          }
        };
        const fail = (message) => {
          clearLoadTimer();
          d3Runtime.status = 'failed';
          d3Runtime.promise = null;
          reject(new Error(message));
        };
        d3LoadTimer = setTimeout(() => {
          d3LoadTimer = 0;
          if (d3Runtime.status === 'loading') {
            if (d3ScriptNode !== null) {
              try {
                d3ScriptNode.remove();
              } catch (error) {
                /* already detached */
              }
              d3ScriptNode = null;
            }
            fail('图谱引擎加载超时，请重试');
          }
        }, 60000);
        const script = document.createElement('script');
        script.src = D3_JS_SRC;
        script.async = true;
        script.setAttribute('data-learning-space', 'd3');
        const onLoad = () => {
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
          clearLoadTimer();
          const d3 = getD3();
          if (d3 === null) {
            fail('图谱引擎加载失败');
            return;
          }
          d3Runtime.status = 'ready';
          dispatchLearningEvent(D3_READY_EVENT);
          resolve(d3);
        };
        const onError = () => {
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
          clearLoadTimer();
          try {
            script.remove();
          } catch (error) {
            /* already detached */
          }
          if (d3ScriptNode === script) d3ScriptNode = null;
          fail('图谱引擎加载失败，请检查后重试');
        };
        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
        d3ScriptNode = script;
        document.head.appendChild(script);
      });
      return d3Runtime.promise;
    }

    function estimateSvgTextWidth(text, fontSize) {
      let width = 0;
      for (const char of String(text)) {
        const code = char.codePointAt(0);
        const wide =
          (code >= 0x2e80 && code <= 0x9fff) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xff00 && code <= 0xffef) ||
          (code >= 0x3000 && code <= 0x303f);
        width += wide ? fontSize : fontSize * 0.56;
      }
      return width;
    }

    function truncateSvgLabel(label, maxWidth, fontSize) {
      const text = typeof label === 'string' ? label : String(label === null || label === undefined ? '' : label);
      if (estimateSvgTextWidth(text, fontSize) <= maxWidth) return text;
      const ellipsisWidth = fontSize;
      let output = '';
      let width = 0;
      for (const char of text) {
        const charWidth = estimateSvgTextWidth(char, fontSize);
        if (width + charWidth + ellipsisWidth > maxWidth) break;
        output += char;
        width += charWidth;
      }
      return output === '' ? '…' : `${output}…`;
    }

    /** Degree-based node radius: 7px base + 1.3px per edge, clamped to 16px. */
    function graphNodeRadius(degree) {
      const value = Number(degree);
      if (!Number.isFinite(value)) return 7;
      return Math.max(7, Math.min(16, 7 + value * 1.3));
    }

    function graphIsWideChar(code) {
      return (
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0x3000 && code <= 0x303f)
      );
    }

    /** Visible graph label: about 8 CJK units (or 16 latin chars), then "…". */
    function truncateGraphLabel(label, maxUnits) {
      const text = typeof label === 'string' ? label : String(label === null || label === undefined ? '' : label);
      const limit = Number.isFinite(maxUnits) ? maxUnits : 8;
      let units = 0;
      let output = '';
      for (const char of text) {
        const unit = graphIsWideChar(char.codePointAt(0)) ? 1 : 0.5;
        if (units + unit > limit + 1e-6) return output === '' ? '…' : `${output}…`;
        output += char;
        units += unit;
      }
      return output;
    }

    /** Estimated width (px) of a graph label at 11px: 11 per CJK, 6.5 per latin. */
    function graphLabelWidth(visible) {
      let width = 0;
      for (const char of String(visible)) width += graphIsWideChar(char.codePointAt(0)) ? 11 : 6.5;
      return width;
    }

    /** Pure graph model: normalized nodes/links/chapters plus degree and radius. */
    function buildGraphModel(graph, chapters, options) {
      const sourceNodes = graph !== null && graph !== undefined && Array.isArray(graph.nodes) ? graph.nodes : [];
      const sourceEdges = graph !== null && graph !== undefined && Array.isArray(graph.edges) ? graph.edges : [];
      const courseChapters = Array.isArray(chapters) ? chapters : [];
      const graphChapters = graph !== null && graph !== undefined && Array.isArray(graph.chapters) ? graph.chapters : [];
      const settings = options !== null && options !== undefined ? options : {};
      const showLocked = settings.showLocked !== false;
      const lockedChapters = settings.lockedChapters instanceof Set ? settings.lockedChapters : new Set();

      const nodeById = new Map();
      const allNodes = [];
      for (const raw of sourceNodes) {
        if (raw === null || typeof raw !== 'object') continue;
        const id = typeof raw.id === 'string' ? raw.id : '';
        if (id === '' || nodeById.has(id)) continue;
        const chapterIndex = Number.isInteger(raw.chapterIndex) && raw.chapterIndex >= 0 ? raw.chapterIndex : 0;
        const label = typeof raw.label === 'string' && raw.label !== '' ? raw.label : id;
        const labelVisible = truncateGraphLabel(label);
        const locked = raw.locked === true || lockedChapters.has(chapterIndex);
        const node = {
          id,
          label,
          labelVisible,
          labelWidth: graphLabelWidth(labelVisible),
          labelBelow: allNodes.length % 2 === 0,
          chapterIndex,
          chapterTitle: typeof raw.chapterTitle === 'string' ? raw.chapterTitle : '',
          colorIndex: chapterIndex % 8,
          degree: 0,
          radius: 7,
          collideRadius: 0,
          locked,
          definition: typeof raw.definition === 'string' ? raw.definition : '',
          difficulty: Number.isFinite(Number(raw.difficulty)) ? Number(raw.difficulty) : null,
        };
        nodeById.set(id, node);
        allNodes.push(node);
      }

      const links = [];
      for (const raw of sourceEdges) {
        if (raw === null || typeof raw !== 'object') continue;
        const source = nodeById.get(raw.source);
        const target = nodeById.get(raw.target);
        if (source === undefined || target === undefined || source.id === target.id) continue;
        const relation =
          raw.relation === 'prerequisite' || raw.relation === 'related' || raw.relation === 'contrast'
            ? raw.relation
            : 'related';
        source.degree += 1;
        target.degree += 1;
        links.push({
          key: `${source.id}->${target.id}:${relation}`,
          source: source.id,
          target: target.id,
          relation,
          locked: source.locked || target.locked,
        });
      }
      for (const node of allNodes) {
        node.radius = graphNodeRadius(node.degree);
        node.collideRadius = Math.max(node.radius + 16, node.labelWidth / 2 + 10);
      }

      const lockedCount = allNodes.filter((node) => node.locked).length;
      const nodes = showLocked ? allNodes : allNodes.filter((node) => !node.locked);
      const visibleIds = new Set(nodes.map((node) => node.id));
      const visibleLinks = links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));
      const visibleNodeById = new Map(nodes.map((node) => [node.id, node]));

      const chapterIndexes = [...new Set(nodes.map((node) => node.chapterIndex))].sort((a, b) => a - b);
      const chapterMeta = chapterIndexes.map((chapterIndex) => {
        const graphChapter = graphChapters.find(
          (item) => item !== null && item !== undefined && item.index === chapterIndex,
        );
        const courseChapter = courseChapters[chapterIndex];
        const firstNode = nodes.find((node) => node.chapterIndex === chapterIndex);
        const title =
          (graphChapter && typeof graphChapter.title === 'string' && graphChapter.title) ||
          (courseChapter && typeof courseChapter.title === 'string' && courseChapter.title) ||
          (firstNode && firstNode.chapterTitle) ||
          `第 ${chapterIndex + 1} 章`;
        return {
          index: chapterIndex,
          title,
          colorIndex: chapterIndex % 8,
          locked:
            (graphChapter !== null && graphChapter !== undefined && graphChapter.locked === true) ||
            lockedChapters.has(chapterIndex),
        };
      });

      return { nodes, links: visibleLinks, chapters: chapterMeta, nodeById: visibleNodeById, lockedCount, showLocked };
    }

    function graphFocusSet(model, focusId) {
      const focus = new Set();
      if (focusId === null || focusId === undefined) return focus;
      focus.add(focusId);
      for (const link of model.links) {
        if (link.source === focusId) focus.add(link.target);
        else if (link.target === focusId) focus.add(link.source);
      }
      return focus;
    }

    function graphIncident(model, nodeId) {
      const incoming = [];
      const outgoing = [];
      const related = [];
      if (nodeId === null || nodeId === undefined) return { incoming, outgoing, related };
      for (const link of model.links) {
        if (link.target === nodeId && link.relation === 'prerequisite') {
          const node = model.nodeById.get(link.source);
          if (node !== undefined) incoming.push(node);
        }
        if (link.source === nodeId && link.relation === 'prerequisite') {
          const node = model.nodeById.get(link.target);
          if (node !== undefined) outgoing.push(node);
        }
        if (link.relation !== 'prerequisite' && (link.source === nodeId || link.target === nodeId)) {
          const node = model.nodeById.get(link.source === nodeId ? link.target : link.source);
          if (node !== undefined) related.push(node);
        }
      }
      return { incoming, outgoing, related };
    }

    /** Deterministic circular fallback when d3 is unavailable. */
    function buildFallbackLayout(model, width, height) {
      const centerX = width / 2;
      const centerY = height / 2;
      const chapterList = model.chapters.length > 0 ? model.chapters : [{ index: 0, title: '' }];
      const radius = Math.min(width, height) * 0.33;
      const anchors = new Map();
      chapterList.forEach((chapter, index) => {
        const angle = (Math.PI * 2 * index) / chapterList.length - Math.PI / 2;
        anchors.set(chapter.index, {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        });
      });

      const grouped = new Map();
      for (const node of model.nodes) {
        if (!grouped.has(node.chapterIndex)) grouped.set(node.chapterIndex, []);
        grouped.get(node.chapterIndex).push(node);
      }

      const positioned = new Map();
      for (const node of model.nodes) {
        const anchor = anchors.get(node.chapterIndex) || { x: centerX, y: centerY };
        const group = grouped.get(node.chapterIndex) || [];
        const position = group.indexOf(node);
        const spread = Math.min(64, 20 + group.length * 7);
        const angle = group.length <= 1 ? 0 : (Math.PI * 2 * position) / group.length;
        const x = group.length <= 1 ? anchor.x : anchor.x + Math.cos(angle) * spread;
        const y = group.length <= 1 ? anchor.y : anchor.y + Math.sin(angle) * spread;
        positioned.set(node.id, {
          ...node,
          x: Math.max(32, Math.min(width - 32, x)),
          y: Math.max(32, Math.min(height - 32, y)),
        });
      }

      const nodes = model.nodes.map((node) => positioned.get(node.id));
      const links = model.links
        .map((link) => {
          const source = positioned.get(link.source);
          const target = positioned.get(link.target);
          if (source === undefined || target === undefined) return null;
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          return {
            ...link,
            x1: source.x + (dx / distance) * (source.radius + 1),
            y1: source.y + (dy / distance) * (source.radius + 1),
            x2: target.x - (dx / distance) * (target.radius + 2),
            y2: target.y - (dy / distance) * (target.radius + 2),
          };
        })
        .filter((link) => link !== null);

      return { nodes, links, width, height };
    }

    function svgArrowMarker(key) {
      return h(
        'defs',
        { key },
        h(
          'marker',
          {
            id: 'ls-graph-arrow',
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: 'auto-start-reverse',
          },
          h('path', { d: 'M0,0 L10,5 L0,10 z', className: 'ls-graph-arrow-head' }),
        ),
      );
    }

    function FallbackGraph({ model, selectedId, onSelect }) {
      const layout = React.useMemo(() => buildFallbackLayout(model, 960, 560), [model]);
      const focus = graphFocusSet(model, selectedId);
      const hasFocus = selectedId !== null;
      return h(
        'svg',
        {
          className: 'ls-graph-svg ls-graph-fallback-svg',
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          role: 'img',
          'aria-label': '课程知识图谱（简化布局）',
        },
        svgArrowMarker('fallback-arrow'),
        layout.links.map((link) =>
          h('line', {
            key: `edge-${link.key}`,
            className: 'ls-graph-edge',
            'data-relation': link.relation,
            'data-locked': link.locked ? '' : undefined,
            'data-highlight':
              hasFocus && (link.source === selectedId || link.target === selectedId) ? '' : undefined,
            'data-dim': hasFocus && link.source !== selectedId && link.target !== selectedId ? '' : undefined,
            x1: link.x1,
            y1: link.y1,
            x2: link.x2,
            y2: link.y2,
            markerEnd: link.relation === 'prerequisite' ? 'url(#ls-graph-arrow)' : undefined,
          }),
        ),
        layout.nodes.map((node) =>
          h(
            'g',
            {
              key: `node-${node.id}`,
              className: 'ls-graph-node',
              'data-chapter': String(node.colorIndex),
              'data-locked': node.locked ? '' : undefined,
              'data-selected': node.id === selectedId ? '' : undefined,
              'data-dim': hasFocus && !focus.has(node.id) ? '' : undefined,
              role: 'button',
              tabIndex: 0,
              onClick: () => onSelect(node.id === selectedId ? null : node.id),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id === selectedId ? null : node.id);
                }
              },
            },
            h('title', null, node.locked ? `${node.label}（未解锁）` : node.label),
            h('circle', { className: 'ls-graph-node-circle', r: node.radius }),
            node.locked ? h('text', { className: 'ls-graph-node-lock', 'text-anchor': 'middle', dy: 3.5 }, '🔒') : null,
            h(
              'text',
              {
                className: 'ls-graph-node-label',
                'text-anchor': 'middle',
                dy: node.labelBelow ? node.radius + 15 : -(node.radius + 8),
              },
              node.labelVisible,
            ),
          ),
        ),
      );
    }

    function GraphPanel({ graph, chapters, curriculum, busy, disabled, onGenerate, onGoChapter }) {
      const curriculumInfo = React.useMemo(
        () => normalizeCurriculum(curriculum, Array.isArray(chapters) ? chapters.length : 0),
        [curriculum, chapters],
      );
      const lockedChapters = React.useMemo(
        () => new Set(curriculumInfo.legacy ? [] : curriculumInfo.locked),
        [curriculumInfo],
      );
      const [showLocked, setShowLocked] = React.useState(true);
      const model = React.useMemo(
        () => buildGraphModel(graph, chapters, { showLocked: true, lockedChapters }),
        [graph, chapters, lockedChapters],
      );
      const hasNodes = model.nodes.length > 0;
      const unlockedChapters = React.useMemo(
        () => new Set(curriculumInfo.legacy ? model.chapters.map((chapter) => chapter.index) : curriculumInfo.unlocked),
        [curriculumInfo, model],
      );
      const [d3Api, setD3Api] = React.useState(() => getD3());
      const [engineState, setEngineState] = React.useState(() => (getD3() !== null ? 'ready' : 'idle'));
      const [retryNonce, setRetryNonce] = React.useState(0);
      const [selectedId, setSelectedId] = React.useState(null);
      const [hoveredId, setHoveredId] = React.useState(null);
      const [tooltip, setTooltip] = React.useState(null);
      const containerRef = React.useRef(null);
      const svgRef = React.useRef(null);
      const networkRef = React.useRef(null);
      const selectedIdRef = React.useRef(null);
      const hoveredIdRef = React.useRef(null);
      const tooltipTimerRef = React.useRef(0);

      React.useEffect(() => {
        selectedIdRef.current = selectedId;
      }, [selectedId]);

      React.useEffect(() => {
        if (selectedId === null) setSidebarCollapsed(false);
      }, [selectedId]);
      React.useEffect(() => {
        hoveredIdRef.current = hoveredId;
      }, [hoveredId]);
      React.useEffect(() => {
        setSelectedId(null);
        setHoveredId(null);
        setTooltip(null);
      }, [graph]);
      React.useEffect(() => {
        if (showLocked || selectedId === null) return;
        const node = model.nodeById.get(selectedId);
        if (node !== undefined && node.locked) {
          setSelectedId(null);
          setHoveredId(null);
          setTooltip(null);
        }
      }, [showLocked, selectedId, model]);
      React.useEffect(
        () => () => {
          if (tooltipTimerRef.current !== 0) window.clearTimeout(tooltipTimerRef.current);
        },
        [],
      );

      React.useEffect(() => {
        if (!hasNodes) return undefined;
        const existing = getD3();
        if (existing !== null) {
          setD3Api(existing);
          setEngineState('ready');
          return undefined;
        }
        let cancelled = false;
        setEngineState('loading');
        loadD3()
          .then((d3) => {
            if (cancelled) return;
            setD3Api(d3);
            setEngineState('ready');
          })
          .catch(() => {
            if (!cancelled) setEngineState('error');
          });
        return () => {
          cancelled = true;
        };
      }, [hasNodes, retryNonce]);

      React.useEffect(() => {
        if (busy || engineState !== 'ready' || d3Api === null || !hasNodes) return undefined;
        const container = containerRef.current;
        const svgElement = svgRef.current;
        if (container === null || svgElement === null) return undefined;

        const d3 = d3Api;
        let width = Math.max(320, container.clientWidth || 900);
        let height = Math.max(360, container.clientHeight || 560);
        const svg = d3.select(svgElement);
        svg.selectAll('*').remove();
        svg
          .attr('viewBox', `0 0 ${width} ${height}`)
          .attr('width', '100%')
          .attr('height', '100%')
          .attr('role', 'img')
          .attr('aria-label', '课程知识图谱');

        svg.append('defs').append('marker')
          .attr('id', 'ls-graph-arrow')
          .attr('viewBox', '0 0 10 10')
          .attr('refX', 9)
          .attr('refY', 5)
          .attr('markerWidth', 7)
          .attr('markerHeight', 7)
          .attr('orient', 'auto-start-reverse')
          .append('path')
          .attr('d', 'M0,0 L10,5 L0,10 z')
          .attr('class', 'ls-graph-arrow-head');

        const viewport = svg.append('g').attr('class', 'ls-graph-viewport');
        const linkLayer = viewport.append('g').attr('class', 'ls-graph-links');
        const nodeLayer = viewport.append('g').attr('class', 'ls-graph-nodes');

        const simNodes = model.nodes.map((node, index) => {
          const angle = (Math.PI * 2 * index) / Math.max(1, model.nodes.length);
          return {
            ...node,
            x: width / 2 + Math.cos(angle) * Math.min(width, height) * 0.18,
            y: height / 2 + Math.sin(angle) * Math.min(width, height) * 0.18,
            vx: 0,
            vy: 0,
          };
        });
        const simNodesById = new Map(simNodes.map((node) => [node.id, node]));
        const simLinks = model.links
          .map((link) => {
            const source = simNodesById.get(link.source);
            const target = simNodesById.get(link.target);
            if (source === undefined || target === undefined) return null;
            return { ...link, source, target };
          })
          .filter((link) => link !== null);

        const linkSel = linkLayer
          .selectAll('line')
          .data(simLinks, (link) => link.key)
          .join('line')
          .attr('class', 'ls-graph-edge')
          .attr('data-relation', (link) => link.relation)
          .attr('data-locked', (link) => (link.locked ? '' : null))
          .attr('marker-end', (link) => (link.relation === 'prerequisite' ? 'url(#ls-graph-arrow)' : null));

        const nodeSel = nodeLayer
          .selectAll('g')
          .data(simNodes, (node) => node.id)
          .join('g')
          .attr('class', 'ls-graph-node')
          .attr('data-chapter', (node) => String(node.colorIndex))
          .attr('data-locked', (node) => (node.locked ? '' : null))
          .attr('role', 'button')
          .attr('tabindex', '0')
          .attr('aria-label', (node) => node.label);

        nodeSel.append('title').text((node) => (node.locked ? `${node.label}（未解锁）` : node.label));
        nodeSel.append('circle').attr('class', 'ls-graph-node-circle').attr('r', (node) => node.radius);
        nodeSel
          .append('text')
          .attr('class', 'ls-graph-node-lock')
          .attr('text-anchor', 'middle')
          .attr('dy', '3.5')
          .text((node) => (node.locked ? '🔒' : ''));
        nodeSel
          .append('text')
          .attr('class', 'ls-graph-node-label')
          .attr('text-anchor', 'middle')
          .attr('dy', (node) => (node.labelBelow ? node.radius + 15 : -(node.radius + 8)))
          .text((node) => node.labelVisible);

        const simulation = d3
          .forceSimulation(simNodes)
          .force('link', d3.forceLink(simLinks).id((node) => node.id).distance(120).strength(0.4))
          .force('charge', d3.forceManyBody().strength(-420))
          .force('center', d3.forceCenter(width / 2, height / 2))
          .force('x', d3.forceX(width / 2).strength(0.04))
          .force('y', d3.forceY(height / 2).strength(0.04))
          .force('collide', d3.forceCollide().radius((node) => node.collideRadius))
          .stop();

        for (let step = 0; step < 180; step += 1) simulation.tick();
        simulation.stop();

        const updatePositions = () => {
          linkSel.each(function updateLink(link) {
            const source = link.source;
            const target = link.target;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;
            d3.select(this)
              .attr('x1', source.x + (dx / distance) * (source.radius + 1))
              .attr('y1', source.y + (dy / distance) * (source.radius + 1))
              .attr('x2', target.x - (dx / distance) * (target.radius + 2))
              .attr('y2', target.y - (dy / distance) * (target.radius + 2));
          });
          nodeSel.attr('transform', (node) => `translate(${node.x},${node.y})`);
        };
        updatePositions();

        let focusId = hoveredIdRef.current !== null ? hoveredIdRef.current : selectedIdRef.current;
        const applyFocus = (nextFocusId) => {
          focusId = nextFocusId === undefined ? focusId : nextFocusId;
          const activeId = focusId === null || focusId === undefined ? null : focusId;
          const focus = graphFocusSet(model, activeId);
          nodeSel
            .attr('data-selected', (node) => (activeId !== null && node.id === activeId ? '' : null))
            .attr('data-highlight', (node) => (activeId !== null && node.id !== activeId && focus.has(node.id) ? '' : null))
            .attr('data-dim', (node) => (activeId !== null && !focus.has(node.id) ? '' : null));
          linkSel
            .attr('data-highlight', (link) =>
              activeId !== null && (link.source.id === activeId || link.target.id === activeId) ? '' : null,
            )
            .attr('data-dim', (link) =>
              activeId !== null && link.source.id !== activeId && link.target.id !== activeId ? '' : null,
            );
        };
        applyFocus(hoveredIdRef.current !== null ? hoveredIdRef.current : selectedIdRef.current);

        const zoom = d3
          .zoom()
          .scaleExtent([0.4, 2.5])
          .on('zoom', (event) => {
            viewport.attr('transform', event.transform);
          });
        svg.call(zoom);
        svg.on('dblclick.zoom', null);

        const fitToView = () => {
          if (simNodes.length === 0) return;
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const node of simNodes) {
            minX = Math.min(minX, node.x - node.radius - 54);
            maxX = Math.max(maxX, node.x + node.radius + 54);
            minY = Math.min(minY, node.y - node.radius - 26);
            maxY = Math.max(maxY, node.y + node.radius + 40);
          }
          const spanX = Math.max(120, maxX - minX);
          const spanY = Math.max(120, maxY - minY);
          const scale = Math.min(2.5, Math.max(0.4, Math.min((width - 48) / spanX, (height - 48) / spanY)));
          const translateX = width / 2 - scale * ((minX + maxX) / 2);
          const translateY = height / 2 - scale * ((minY + maxY) / 2);
          svg.call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
        };
        fitToView();

        let fittedOnce = true;
        simulation.on('tick', updatePositions);
        simulation.on('end', () => {
          if (!fittedOnce) {
            fittedOnce = true;
            fitToView();
          }
        });

        let fitTimer = 0;
        const relayout = () => {
          simNodes.forEach((node, index) => {
            const angle = (Math.PI * 2 * index) / Math.max(1, simNodes.length);
            node.x = width / 2 + Math.cos(angle) * Math.min(width, height) * 0.18;
            node.y = height / 2 + Math.sin(angle) * Math.min(width, height) * 0.18;
            node.vx = 0;
            node.vy = 0;
            node.fx = null;
            node.fy = null;
          });
          fittedOnce = false;
          simulation.alpha(1).restart();
        };

        const drag = d3
          .drag()
          .on('start', (event, node) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            node.fx = node.x;
            node.fy = node.y;
          })
          .on('drag', (event, node) => {
            node.fx = event.x;
            node.fy = event.y;
          })
          .on('end', (event, node) => {
            if (!event.active) simulation.alphaTarget(0);
            node.fx = null;
            node.fy = null;
          });
        nodeSel.call(drag);

        const cancelTooltipHide = () => {
          if (tooltipTimerRef.current !== 0) {
            window.clearTimeout(tooltipTimerRef.current);
            tooltipTimerRef.current = 0;
          }
        };
        const scheduleTooltipHide = () => {
          cancelTooltipHide();
          tooltipTimerRef.current = window.setTimeout(() => {
            tooltipTimerRef.current = 0;
            setTooltip(null);
          }, 120);
        };
        const moveTooltip = (event, node) => {
          const rect = container.getBoundingClientRect();
          const availableWidth = rect.width || width;
          const availableHeight = rect.height || height;
          setTooltip({
            x: Math.max(8, Math.min(event.clientX - rect.left + 12, availableWidth - 268)),
            y: Math.max(8, Math.min(event.clientY - rect.top + 12, availableHeight - 92)),
            node,
          });
        };

        nodeSel
          .on('mouseenter', (event, node) => {
            cancelTooltipHide();
            setHoveredId(node.id);
            moveTooltip(event, node);
          })
          .on('mousemove', (event, node) => {
            moveTooltip(event, node);
          })
          .on('mouseleave', () => {
            setHoveredId(null);
            scheduleTooltipHide();
          })
          .on('click', (event, node) => {
            event.stopPropagation();
            setSelectedId((previous) => (previous === node.id ? null : node.id));
          })
          .on('keydown', (event, node) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setSelectedId((previous) => (previous === node.id ? null : node.id));
            }
          });

        svg.on('click', () => {
          setSelectedId(null);
          setHoveredId(null);
          setTooltip(null);
        });
        svg.on('dblclick', fitToView);

        let resizeTimer = 0;
        let observedInitialSize = false;
        const handleResize = () => {
          if (!observedInitialSize) {
            observedInitialSize = true;
            return;
          }
          if (resizeTimer !== 0) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            resizeTimer = 0;
            width = Math.max(320, container.clientWidth || width);
            height = Math.max(360, container.clientHeight || height);
            svg.attr('viewBox', `0 0 ${width} ${height}`);
            simulation.force('center', d3.forceCenter(width / 2, height / 2));
            simulation.force('x', d3.forceX(width / 2).strength(0.04));
            simulation.force('y', d3.forceY(height / 2).strength(0.04));
            simulation.alpha(0.35).restart();
            if (fitTimer !== 0) window.clearTimeout(fitTimer);
            fitTimer = window.setTimeout(() => {
              fitTimer = 0;
              fitToView();
            }, 260);
          }, 150);
        };
        let resizeObserver = null;
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(handleResize);
          resizeObserver.observe(container);
        } else {
          window.addEventListener('resize', handleResize);
        }

        networkRef.current = {
          fit: fitToView,
          relayout,
          applyFocus: (focusValue) => applyFocus(focusValue),
        };

        return () => {
          simulation.stop();
          simulation.on('tick', null);
          simulation.on('end', null);
          svg.on('.zoom', null);
          svg.on('dblclick.zoom', null);
          svg.on('dblclick', null);
          svg.on('click', null);
          if (nodeSel !== null && nodeSel !== undefined) {
            nodeSel.on('.drag', null);
            nodeSel.on('mouseenter', null);
            nodeSel.on('mousemove', null);
            nodeSel.on('mouseleave', null);
            nodeSel.on('click', null);
            nodeSel.on('keydown', null);
          }
          if (tooltipTimerRef.current !== 0) {
            window.clearTimeout(tooltipTimerRef.current);
            tooltipTimerRef.current = 0;
          }
          if (resizeTimer !== 0) window.clearTimeout(resizeTimer);
          if (fitTimer !== 0) window.clearTimeout(fitTimer);
          if (resizeObserver !== null) resizeObserver.disconnect();
          else window.removeEventListener('resize', handleResize);
          svg.selectAll('*').remove();
          networkRef.current = null;
        };
      }, [d3Api, engineState, hasNodes, model, busy]);

      React.useEffect(() => {
        const network = networkRef.current;
        if (network !== null) network.applyFocus(hoveredId !== null ? hoveredId : selectedId);
      }, [selectedId, hoveredId, engineState, model]);

      if (busy) {
        return h('div', { className: 'ls-graph-loading' }, h(Spinner, null), '正在生成知识图谱…（约 10–40 秒）');
      }
      if (graph === null || graph === undefined) {
        return h(
          'div',
          { className: 'ls-graph-empty' },
          h(BookIcon, { size: 36 }),
          h('div', { className: 'ls-empty-title' }, '还没有知识图谱'),
          h(
            'p',
            { className: 'ls-empty-text' },
            '根据课程大纲的概念生成知识图谱，展示概念之间的前置、相关与对比关系。',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ls-btn ls-btn-primary',
              onClick: () => onGenerate(false),
              disabled: disabled === true,
            },
            '生成知识图谱',
          ),
        );
      }
      if (!hasNodes) {
        return h(
          'div',
          { className: 'ls-graph-empty' },
          h(BookIcon, { size: 36 }),
          h('div', { className: 'ls-empty-title' }, '知识图谱暂无节点'),
          h('p', { className: 'ls-empty-text' }, '图谱数据为空，可以尝试重新生成。'),
          h(
            'button',
            {
              type: 'button',
              className: 'ls-btn ls-btn-primary',
              onClick: () => onGenerate(true),
              disabled: disabled === true,
            },
            '重新生成',
          ),
        );
      }

      const selected = selectedId === null ? null : model.nodeById.get(selectedId) || null;
      const selectedChapter =
        selected === null ? null : model.chapters.find((chapter) => chapter.index === selected.chapterIndex) || null;
      const incident = graphIncident(model, selected === null ? null : selected.id);
      const enabledChapters = new Set();
      if (Array.isArray(chapters)) {
        chapters.forEach((chapter, index) => {
          if (chapter !== null && chapter !== undefined) enabledChapters.add(index);
        });
      }
      const selectedUnlocked =
        selected !== null &&
        !selected.locked &&
        (curriculumInfo.legacy || unlockedChapters.has(selected.chapterIndex));
      const selectedGenerated = selected !== null && enabledChapters.has(selected.chapterIndex);
      const canJump = selected !== null && selectedUnlocked && selectedGenerated;
      const selectedUnlockHint =
        selected === null ? '' : `完成第 ${Math.max(1, selected.chapterIndex)} 章并让测验与概念掌握达到 ${curriculumInfo.masteryThreshold}% 后解锁`;

      const conceptButtons = (nodeList) =>
        nodeList.length === 0
          ? h('span', { className: 'ls-graph-hint' }, '无')
          : h(
              'div',
              { className: 'ls-chips' },
              nodeList.map((node) =>
                h(
                  'button',
                  {
                    key: node.id,
                    type: 'button',
                    className: 'ls-graph-chip',
                    title: node.label,
                    onClick: () => setSelectedId(node.id),
                  },
                  truncateSvgLabel(node.label, 150, 11),
                ),
              ),
            );

      const legendItem = (relation, label) =>
        h(
          'span',
          { key: relation, className: 'ls-graph-legend-item' },
          h('span', { className: 'ls-graph-legend-line', 'data-relation': relation }),
          label,
        );

      const derived = graph.source === 'derived';
      const engineReady = engineState === 'ready';

      return h(
        'div',
        { className: 'ls-graph' },
        derived
          ? h(
              'div',
              { className: 'ls-banner', 'data-kind': 'warn' },
              h('span', { className: 'ls-banner-text' }, 'AI 关系生成失败，当前为按章节推导的基础关系。'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-sm',
                  onClick: () => onGenerate(true),
                  disabled: disabled === true,
                },
                '重新生成',
              ),
            )
          : null,
        engineState === 'error'
          ? h(
              'div',
              { className: 'ls-banner', 'data-kind': 'warn' },
              h('span', { className: 'ls-banner-text' }, '图谱引擎加载失败，已使用简化布局。'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-sm',
                  onClick: () => {
                    disposeD3Assets();
                    setRetryNonce((value) => value + 1);
                  },
                },
                '重试',
              ),
            )
          : null,
        h(
          'div',
          { className: 'ls-graph-toolbar' },
          h(
            'p',
            { className: 'ls-graph-hint' },
            `共 ${model.nodes.length} 个概念、${model.links.length} 条关系${model.lockedCount > 0 ? `（其中 ${model.lockedCount} 个未解锁）` : ''}。滚轮缩放 · 拖动空白平移 · 双击空白适应画布 · 拖动节点调整位置 · 点击节点查看详情。`,
          ),
          h(
            'div',
            { className: 'ls-graph-actions' },
            model.lockedCount > 0
              ? h(
                  'label',
                  { className: 'ls-graph-toggle' },
                  h('input', {
                    type: 'checkbox',
                    checked: showLocked,
                    onChange: (event) => setShowLocked(event.target.checked),
                  }),
                  '显示未解锁概念',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm',
                disabled: !engineReady,
                onClick: () => {
                  const network = networkRef.current;
                  if (network !== null) network.fit();
                },
              },
              '适应画布',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm',
                disabled: !engineReady,
                onClick: () => {
                  const network = networkRef.current;
                  if (network !== null) network.relayout();
                },
              },
              '重新布局',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm',
                disabled: disabled === true,
                onClick: () => onGenerate(true),
              },
              '重新生成图谱',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ls-graph-legend' },
          legendItem('prerequisite', GRAPH_HIGHLIGHT_RELATIONS.prerequisite),
          legendItem('related', GRAPH_HIGHLIGHT_RELATIONS.related),
          legendItem('contrast', GRAPH_HIGHLIGHT_RELATIONS.contrast),
          model.chapters.map((chapter) =>
            h(
              'span',
              { key: `chapter-${chapter.index}`, className: 'ls-graph-legend-item' },
              h('span', {
                className: 'ls-graph-legend-dot',
                'data-chapter': String(chapter.colorIndex),
              }),
              chapter.locked ? h(LockIcon, { size: 11 }) : null,
              `第 ${chapter.index + 1} 章 · ${truncateSvgLabel(chapter.title, 140, 11)}`,
            ),
          ),
        ),
        h(
          'div',
          { className: 'ls-graph-canvas', ref: containerRef, 'data-hide-locked': showLocked ? undefined : '' },
          engineState === 'error'
            ? h(FallbackGraph, { model, selectedId, onSelect: setSelectedId })
            : engineState === 'ready'
              ? h('svg', { ref: svgRef, className: 'ls-graph-svg', role: 'img', 'aria-label': '课程知识图谱' })
              : h(
                  'div',
                  { className: 'ls-graph-engine-loading' },
                  h(Spinner, null),
                  '正在加载图谱引擎…',
                ),
          tooltip !== null && engineState === 'ready'
            ? h(
                'div',
                {
                  className: 'ls-graph-tooltip',
                  style: { left: `${tooltip.x}px`, top: `${tooltip.y}px` },
                },
                h('div', { className: 'ls-graph-tooltip-title' }, tooltip.node.label),
                h(
                  'div',
                  { className: 'ls-graph-tooltip-meta' },
                  `第 ${tooltip.node.chapterIndex + 1} 章${tooltip.node.chapterTitle ? ` · ${tooltip.node.chapterTitle}` : ''} · 度数 ${tooltip.node.degree}${tooltip.node.locked ? ` · 未解锁：完成第 ${Math.max(1, tooltip.node.chapterIndex)} 章后学习` : ''}`,
                ),
              )
            : null,
        ),
        selected === null
          ? h(
              'p',
              { className: 'ls-graph-hint' },
              '点击节点查看概念详情；悬停可高亮相邻概念，选中后其余节点会淡出。',
            )
          : h(
              'div',
              { className: 'ls-graph-info' },
              h(
                'div',
                { className: 'ls-graph-info-head' },
                h('h3', { className: 'ls-graph-info-title' }, selected.label),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn ls-btn-sm',
                    disabled: !canJump,
                    title: canJump
                      ? '打开该章阅读'
                      : !selectedUnlocked
                        ? selectedUnlockHint
                        : '该章尚未生成',
                    onClick: () => {
                      if (canJump) onGoChapter(selected.chapterIndex);
                    },
                  },
                  `跳到第 ${selected.chapterIndex + 1} 章阅读`,
                ),
              ),
              curriculumInfo.legacy
                ? null
                : h(
                    'div',
                    { className: 'ls-graph-info-row' },
                    h('span', { className: 'ls-graph-info-label' }, '解锁状态'),
                    h(
                      'span',
                      { className: selectedUnlocked ? undefined : 'ls-graph-locked-text' },
                      selectedUnlocked ? '已解锁' : `未解锁 · ${selectedUnlockHint}`,
                    ),
                  ),
              h(
                'div',
                { className: 'ls-graph-info-row' },
                h('span', { className: 'ls-graph-info-label' }, '所属章节'),
                h(
                  'span',
                  null,
                  `第 ${selected.chapterIndex + 1} 章${selectedChapter && selectedChapter.title ? ` · ${selectedChapter.title}` : ''}`,
                ),
              ),
              h(
                'div',
                { className: 'ls-graph-info-row' },
                h('span', { className: 'ls-graph-info-label' }, '前置概念'),
                conceptButtons(incident.incoming),
              ),
              h(
                'div',
                { className: 'ls-graph-info-row' },
                h('span', { className: 'ls-graph-info-label' }, '后继概念'),
                conceptButtons(incident.outgoing),
              ),
              h(
                'div',
                { className: 'ls-graph-info-row' },
                h('span', { className: 'ls-graph-info-label' }, '相关概念'),
                conceptButtons(incident.related),
              ),
            ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Review panel (spaced repetition)                                  */
    /* ---------------------------------------------------------------- */

    function reviewItemNode({ item, now, upcoming, onStartReview }) {
      const review = item.review;
      const lastScore =
        review !== null && review !== undefined && Number.isFinite(Number(review.lastScore))
          ? `${Number(review.lastScore)}%`
          : item.quizResult !== null && item.quizResult !== undefined
            ? `${Number(item.quizResult.score) || 0} / ${Number(item.quizResult.total) || 0}`
            : '—';
      const meta = [];
      meta.push(h('span', { key: 'score' }, `上次得分 ${lastScore}`));
      if (review !== null && review !== undefined) {
        meta.push(h('span', { key: 'due' }, upcoming ? `下次复习：${formatReviewDue(review.due, now)}` : formatReviewDue(review.due, now)));
        if (Number.isFinite(Number(review.intervalDays))) {
          meta.push(h('span', { key: 'interval' }, `间隔 ${Number(review.intervalDays)} 天`));
        }
      } else {
        meta.push(h('span', { key: 'due' }, '未复习'));
      }
      return h(
        'div',
        { key: item.index, className: 'ls-review-item', 'data-upcoming': upcoming ? '' : undefined },
        h(
          'div',
          { className: 'ls-review-body' },
          h('div', { className: 'ls-review-title' }, item.title),
          h(
            'div',
            {
              className: 'ls-review-meta',
              'data-overdue': !upcoming && review !== null && review !== undefined ? '' : undefined,
            },
            meta,
          ),
        ),
        h(
          'div',
          { className: 'ls-review-actions' },
          h(
            'button',
            {
              type: 'button',
              className: upcoming ? 'ls-btn ls-btn-sm' : 'ls-btn ls-btn-sm ls-btn-primary',
              onClick: () => onStartReview(item.index),
            },
            upcoming ? '提前复习' : '开始复习',
          ),
        ),
      );
    }

    function ReviewPanel({ course, progressEntry, now, onStartReview }) {
      const info = reviewChapterItems(course, progressEntry, now);
      if (info.items.length === 0) {
        return h(
          'div',
          { className: 'ls-review' },
          h(
            'div',
            { className: 'ls-review-stats' },
            '到期 ',
            h('strong', null, '0'),
            ' 章 · 共 ',
            h('strong', null, '0'),
            ' 章可复习',
          ),
          h(
            'div',
            { className: 'ls-review-empty' },
            h(BookIcon, { size: 32 }),
            h('div', { className: 'ls-empty-title' }, '暂无可复习的章节'),
            h('p', { className: 'ls-empty-text' }, '生成章节并完成章末测验后，这里会按间隔重复排出复习计划。'),
          ),
        );
      }
      return h(
        'div',
        { className: 'ls-review' },
        h(
          'div',
          { className: 'ls-review-stats' },
          '到期 ',
          h('strong', null, String(info.due.length)),
          ' 章 · 共 ',
          h('strong', null, String(info.total)),
          ' 章可复习',
        ),
        h(
          'div',
          { className: 'ls-review-section' },
          h('div', { className: 'ls-review-section-title' }, `已到期（${info.due.length}）`),
          info.due.length === 0
            ? h('div', { className: 'ls-review-empty' }, '暂无到期复习')
            : info.due.map((item) => reviewItemNode({ item, now, upcoming: false, onStartReview })),
        ),
        info.unscheduled.length > 0
          ? h(
              'div',
              { className: 'ls-review-section' },
              h('div', { className: 'ls-review-section-title' }, `还没排期（${info.unscheduled.length}）`),
              info.unscheduled.map((item) => reviewItemNode({ item, now, upcoming: false, onStartReview })),
            )
          : null,
        info.upcoming.length > 0
          ? h(
              'div',
              { className: 'ls-review-section' },
              h('div', { className: 'ls-review-section-title' }, `未到期（${info.upcoming.length}）`),
              info.upcoming.map((item) => reviewItemNode({ item, now, upcoming: true, onStartReview })),
            )
          : null,
      );
    }

    /* ---------------------------------------------------------------- */
    /* Review session                                                    */
    /* ---------------------------------------------------------------- */

    function ReviewSession({ course, chapter, index, quizResult, graph, onBack, onRecordQuiz }) {
      const [nextReview, setNextReview] = React.useState(null);
      const outline = Array.isArray(course.outline) ? course.outline : [];
      const outlineItem = outline[index] || {};
      const title = outlineItem.title || chapter.title || `第 ${index + 1} 章`;
      const graphNodes =
        graph !== null && graph !== undefined && Array.isArray(graph.nodes)
          ? graph.nodes.filter(
              (node) => node !== null && typeof node === 'object' && node.chapterIndex === index && typeof node.label === 'string',
            )
          : [];
      const questions =
        chapter.quiz !== null && chapter.quiz !== undefined && Array.isArray(chapter.quiz.questions)
          ? chapter.quiz.questions
          : [];

      const handleSubmit = (result) => {
        const entry = onRecordQuiz(index, result);
        setNextReview(entry);
      };

      return h(
        'div',
        { className: 'ls-panel' },
        h(
          'div',
          { className: 'ls-reader-bar' },
          h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onBack }, '← 返回复习'),
          h(
            'div',
            { className: 'ls-reader-center' },
            h('span', { className: 'ls-reader-counter' }, `复习：第 ${index + 1} 章`),
            h(
              'div',
              { className: 'ls-reader-title-row' },
              h('span', { className: 'ls-reader-title', title }, title),
            ),
          ),
          h(
            'div',
            { className: 'ls-reader-nav' },
            quizResult !== null && quizResult !== undefined
              ? h(
                  Tag,
                  { tone: 'level' },
                  `上次得分 ${Number(quizResult.score) || 0} / ${Number(quizResult.total) || 0}`,
                )
              : null,
          ),
        ),
        h(
          'div',
          { className: 'ls-reader-scroll', key: index },
          h(
            'div',
            { className: 'ls-reader-inner' },
            graphNodes.length > 0
              ? h(
                  'div',
                  { className: 'ls-review-concepts' },
                  graphNodes.slice(0, 10).map((node) =>
                    h('span', { key: node.id, className: 'ls-chip', title: node.label }, node.label),
                  ),
                )
              : null,
            questions.length === 0
              ? h('div', { className: 'ls-quiz-empty' }, '本章暂无测验，无法复习。')
              : h(QuizPanel, {
                  key: `review-quiz-${index}`,
                  title: '复习测验',
                  quiz: chapter.quiz,
                  lastResult: quizResult,
                  onSubmit: handleSubmit,
                  afterSubmit:
                    nextReview !== null
                      ? h(
                          'div',
                          null,
                          h(
                            'div',
                            { className: 'ls-review-next' },
                            `下次复习：${nextReview.intervalDays} 天后（${formatShortDate(nextReview.due)}）`,
                          ),
                          h(
                            'div',
                            { className: 'ls-review-actions', style: { marginTop: 12 } },
                            h(
                              'button',
                              { type: 'button', className: 'ls-btn', onClick: onBack },
                              '返回复习列表',
                            ),
                          ),
                        )
                      : null,
                }),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Course detail (chapters / graph / review tabs)                    */
    /* ---------------------------------------------------------------- */

    function ChapterList({ course, progressEntry, generation, activeChapter, running, graphBusy, onGenerateChapter, onRead }) {
      const stats = courseStats(course);
      const entry = normalizeProgressEntry(progressEntry);
      const doneSet = new Set(entry.done.filter((index) => index >= 0 && index < stats.total));
      const courseId = course.id;
      const outline = Array.isArray(course.outline) ? course.outline : [];
      const chapters = Array.isArray(course.chapters) ? course.chapters : [];

      if (stats.total === 0) {
        return h(
          'div',
          { className: 'ls-empty' },
          h(BookIcon, { size: 36 }),
          h('div', { className: 'ls-empty-title' }, '课程还没有大纲'),
          h('p', { className: 'ls-empty-text' }, '可以删除后重新创建课程，让 AI 重新设计章节结构。'),
        );
      }

      return h(
        'div',
        { className: 'ls-chapter-list' },
        outline.map((outlineItem, index) => {
          const chapter = chapters[index] || null;
          const generated = Boolean(chapter);
          const locked = !chapterIsUnlocked(course, index);
          const isDone = doneSet.has(index);
          const isBusy =
            !locked &&
            running &&
            generation !== null &&
            generation.courseId === courseId &&
            generation.currentIndex === index;
          const item = outlineItem && typeof outlineItem === 'object' ? outlineItem : {};
          const concepts = Array.isArray(item.concepts)
            ? item.concepts.filter((concept) => typeof concept === 'string' && concept !== '').slice(0, 5)
            : [];
          const lockHint = locked ? unlockHintFor(course, index) : '';
          return h(
            'div',
            {
              key: index,
              className: 'ls-chapter-row',
              'data-generated': generated ? '' : undefined,
              'data-active': !locked && activeChapter === index ? '' : undefined,
              'data-locked': locked ? '' : undefined,
              'aria-disabled': locked ? 'true' : undefined,
              title: locked ? lockHint : undefined,
            },
            h(
              'span',
              { className: 'ls-chapter-no', 'aria-hidden': true },
              locked ? h(LockIcon, { size: 15 }) : isDone ? '✓' : String(index + 1),
            ),
            h(
              'div',
              { className: 'ls-chapter-body' },
              h(
                'div',
                { className: 'ls-chapter-title' },
                h('span', null, item.title || `第 ${index + 1} 章`),
                locked ? h('span', { className: 'ls-lock-badge' }, '未解锁') : null,
                !locked && isDone ? h('span', { className: 'ls-done-badge' }, '已完成') : null,
              ),
              item.summary ? h('div', { className: 'ls-chapter-summary' }, item.summary) : null,
              locked
                ? h('div', { className: 'ls-chapter-lock-hint' }, lockHint)
                : h(
                    'div',
                    { className: 'ls-chapter-meta' },
                    item.durationMinutes ? h('span', null, `约 ${item.durationMinutes} 分钟`) : null,
                    concepts.length > 0
                      ? h(
                          'div',
                          { className: 'ls-chips' },
                          concepts.map((concept, conceptIndex) =>
                            h('span', { key: conceptIndex, className: 'ls-chip' }, concept),
                          ),
                        )
                      : null,
                  ),
            ),
            h(
              'div',
              { className: 'ls-chapter-actions' },
              locked
                ? h(
                    'span',
                    { className: 'ls-chapter-locked', title: lockHint },
                    h(LockIcon, { size: 13 }),
                    '未解锁',
                  )
                : isBusy
                  ? h('span', { className: 'ls-chapter-busy' }, h(Spinner, null), '生成中…')
                  : null,
              locked
                ? null
                : generated
                  ? h(
                      'button',
                      { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => onRead(index) },
                      isDone ? '重读' : '阅读',
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'ls-btn ls-btn-sm ls-btn-primary',
                        onClick: () => onGenerateChapter(index),
                        disabled: running || graphBusy === true,
                        title:
                          running
                            ? '正在生成其它章节，请稍候'
                            : graphBusy === true
                              ? '知识图谱生成中，请稍候'
                              : '生成本章内容',
                      },
                      '生成',
                    ),
            ),
          );
        }),
      );
    }

    function UnlockRequirements({ curriculum, compact }) {
      if (curriculum === null || curriculum === undefined || curriculum.legacy) return null;
      const next = curriculum.nextUnlock;
      return h(
        'div',
        { className: 'ls-unlock-card', 'data-compact': compact === true ? '' : undefined },
        h(
          'div',
          { className: 'ls-unlock-head' },
          h('span', { className: 'ls-unlock-count' }, `已解锁 ${curriculum.unlocked.length} / ${curriculum.total} 章`),
          next === null
            ? h('span', { className: 'ls-unlock-done' }, '已全部解锁')
            : h('span', { className: 'ls-unlock-next' }, `下一章：第 ${next.index + 1} 章${next.chapterTitle ? ` · ${next.chapterTitle}` : ''}`),
        ),
        next !== null
          ? h(
              'ul',
              { className: 'ls-unlock-req-list' },
              next.requirements.map((requirement) =>
                h(
                  'li',
                  { key: requirement.key || requirement.label, className: 'ls-unlock-req', 'data-met': requirement.met ? '' : undefined },
                  h('span', { className: 'ls-unlock-req-mark', 'aria-hidden': true }, requirement.met ? '✓' : '✗'),
                  h('span', { className: 'ls-unlock-req-label' }, requirement.label),
                  requirement.detail !== '' ? h('span', { className: 'ls-unlock-req-detail' }, requirement.detail) : null,
                ),
              ),
            )
          : null,
      );
    }

    function RetrainModal({ course, item, initialVariant, onClose, onToast, onRefreshDetail }) {
      const [variant, setVariant] = React.useState(initialVariant === true);
      const [phase, setPhase] = React.useState('loading');
      const [question, setQuestion] = React.useState(null);
      const [error, setError] = React.useState('');
      const [selected, setSelected] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const aliveRef = React.useRef(true);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      const load = React.useCallback(async () => {
        setPhase('loading');
        setError('');
        setSelected(null);
        setResult(null);
        try {
          const response = await callApi('retrain-question', {
            id: course.id,
            chapterIndex: item.chapterIndex,
            questionIndex: item.questionIndex,
            variant,
          });
          if (!aliveRef.current) return;
          if (response.question === null || response.question === undefined) throw new Error('题目为空');
          setQuestion(response.question);
          setPhase('ready');
        } catch (failure) {
          if (!aliveRef.current) return;
          setPhase('error');
          setError(failure && failure.message ? failure.message : '加载题目失败');
        }
      }, [course.id, item.chapterIndex, item.questionIndex, variant]);

      React.useEffect(() => {
        void load();
      }, [load]);

      const submit = async () => {
        if (selected === null || busy) return;
        setBusy(true);
        try {
          const response = await callApi('retrain-answer', {
            id: course.id,
            chapterIndex: item.chapterIndex,
            questionIndex: item.questionIndex,
            variant,
            answer: selected,
          });
          if (!aliveRef.current) return;
          setResult(response);
          if (onToast) {
            onToast({
              kind: response.correct ? 'success' : 'warn',
              text: response.correct ? '答对了，已订正这道错题' : '还是不对，再看一遍解析继续练',
            });
          }
          if (onRefreshDetail) onRefreshDetail();
        } catch (failure) {
          if (onToast) onToast({ kind: 'error', text: failure && failure.message ? failure.message : '提交答案失败' });
        } finally {
          if (aliveRef.current) setBusy(false);
        }
      };

      const current = question;
      const answered = result !== null;

      return h(
        'div',
        {
          className: 'ls-retrain-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'ls-retrain-panel' },
          h(
            'div',
            { className: 'ls-retrain-head' },
            h(
              'div',
              { className: 'ls-retrain-head-main' },
              h('h3', { className: 'ls-retrain-title' }, variant ? '错题变式训练' : '错题重做'),
              h('span', { className: 'ls-retrain-sub' }, `${item.chapterTitle || `第 ${item.chapterIndex + 1} 章`} · ${variant ? '同知识点变式题' : '原题重做'}`),
            ),
            h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onClose, 'aria-label': '关闭' }, '✕'),
          ),
          h(
            'div',
            { className: 'ls-retrain-body' },
            phase === 'loading' ? h('div', { className: 'ls-retrain-loading' }, h(Spinner, null), variant ? '正在生成同知识点变式题…' : '正在加载题目…') : null,
            phase === 'error'
              ? h(
                  'div',
                  { className: 'ls-retrain-error' },
                  h('div', null, error),
                  h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: () => void load() }, '重试'),
                )
              : null,
            phase === 'ready' && current !== null
              ? h(
                  'div',
                  { className: 'ls-retrain-question' },
                  h('div', { className: 'ls-retrain-stem' }, current.question),
                  (current.concepts || []).length > 0
                    ? h('div', { className: 'ls-retrain-concepts' }, current.concepts.map((name) => h('span', { key: name, className: 'ls-chip' }, name)))
                    : null,
                  h(
                    'div',
                    { className: 'ls-retrain-options' },
                    (current.options || []).map((option, optionIndex) => {
                      const isSelected = selected === optionIndex;
                      const isCorrect = answered && optionIndex === Number(result.correctIndex);
                      const isWrongSelected = answered && isSelected && !result.correct;
                      return h(
                        'button',
                        {
                          key: optionIndex,
                          type: 'button',
                          className: 'ls-retrain-option',
                          'data-selected': isSelected && !answered ? '' : undefined,
                          'data-correct': isCorrect ? '' : undefined,
                          'data-wrong': isWrongSelected ? '' : undefined,
                          disabled: answered || busy,
                          onClick: () => setSelected(optionIndex),
                        },
                        h('span', { className: 'ls-retrain-option-mark' }, String.fromCharCode(65 + optionIndex)),
                        h('span', { className: 'ls-retrain-option-text' }, option),
                        isCorrect ? h('span', { className: 'ls-retrain-tag' }, '正确答案') : null,
                        isWrongSelected ? h('span', { className: 'ls-retrain-tag ls-retrain-tag-wrong' }, '你的选择') : null,
                      );
                    }),
                  ),
                  answered
                    ? h(
                        'div',
                        { className: 'ls-retrain-result', 'data-correct': result.correct ? '' : undefined },
                        h('div', { className: 'ls-retrain-result-title' }, result.correct ? '✓ 答对了，这道错题已订正' : '✗ 再想想，看看解析'),
                        result.explanation !== '' ? h('div', { className: 'ls-retrain-explain' }, h('span', { className: 'ls-retrain-explain-label' }, '解析'), result.explanation) : null,
                        h('div', { className: 'ls-retrain-stats' }, `本题练过 ${result.retrain.attempts} 次，答对 ${result.retrain.correct} 次`),
                      )
                    : null,
                )
              : null,
          ),
          h(
            'div',
            { className: 'ls-retrain-footer' },
            h(
              'div',
              { className: 'ls-retrain-nav' },
              h('button', { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => setVariant(false), disabled: variant || busy }, '重做原题'),
              h('button', { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => setVariant(true), disabled: variant || busy }, '换变式题'),
            ),
            h(
              'div',
              { className: 'ls-retrain-actions' },
              answered
                ? h('button', { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => { setSelected(null); setResult(null); } }, '再练一次')
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-sm ls-btn-primary',
                  disabled: selected === null || busy || answered,
                  onClick: () => void submit(),
                },
                busy ? h(Spinner, null) : null,
                busy ? '提交中…' : '提交答案',
              ),
            ),
          ),
        ),
      );
    }

    function WrongBookPanel({ course, onGoChapter, onToast, onRefreshDetail }) {
      const items = Array.isArray(course.wrongBook) ? course.wrongBook : [];
      const [retrain, setRetrain] = React.useState(null);
      const unresolved = items.filter((item) => item.resolved !== true).length;
      const unlocked = new Set(curriculumOf(course).unlocked);
      if (items.length === 0) {
        return h(
          'div',
          { className: 'ls-empty' },
          h(BookIcon, { size: 36 }),
          h('div', { className: 'ls-empty-title' }, '暂无错题'),
          h('p', { className: 'ls-empty-text' }, '完成章末测验后，答错的题会按章节和概念汇总到这里。'),
        );
      }
      const groups = new Map();
      for (const item of items) {
        const key = Number(item.chapterIndex);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      return h(
        'div',
        { className: 'ls-wrongbook' },
        h('p', { className: 'ls-hint' }, `共 ${items.length} 道错题，已订正 ${items.length - unresolved} 道。正确项用绿色标出，你的选择用红色标出；点「重做」或「变式」进入错题重练。`),
        Array.from(groups.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([chapterIndex, groupItems]) =>
            h(
              'section',
              { key: chapterIndex, className: 'ls-wrongbook-group' },
              h(
                'div',
                { className: 'ls-wrongbook-group-head' },
                h('h3', { className: 'ls-wrongbook-group-title' }, groupItems[0].chapterTitle || `第 ${chapterIndex + 1} 章`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn ls-btn-sm',
                    disabled: !unlocked.has(chapterIndex),
                    onClick: () => onGoChapter(chapterIndex),
                  },
                  '去阅读',
                ),
              ),
              groupItems.map((item, itemIndex) =>
                h(
                  'div',
                  { key: `${chapterIndex}-${item.questionIndex}-${itemIndex}`, className: 'ls-wrongbook-item', 'data-resolved': item.resolved === true ? '' : undefined },
                  h(
                    'div',
                    { className: 'ls-wrongbook-item-head' },
                    h('div', { className: 'ls-wrongbook-question' }, item.question),
                    item.resolved === true ? h('span', { className: 'ls-wrongbook-resolved' }, '已订正') : null,
                  ),
                  item.retrain !== null && item.retrain !== undefined
                    ? h('div', { className: 'ls-wrongbook-retrain-meta' }, `已重练 ${item.retrain.attempts} 次，答对 ${item.retrain.correct} 次`)
                    : null,
                  (item.options || []).map((option, optionIndex) =>
                    h(
                      'div',
                      {
                        key: optionIndex,
                        className: 'ls-wrongbook-option',
                        'data-correct': optionIndex === Number(item.answerIndex) ? '' : undefined,
                        'data-chosen': optionIndex === Number(item.chosen) ? '' : undefined,
                      },
                      h('span', { className: 'ls-wrongbook-option-mark' }, String.fromCharCode(65 + optionIndex)),
                      h('span', { className: 'ls-wrongbook-option-text' }, option),
                      optionIndex === Number(item.answerIndex)
                        ? h('span', { className: 'ls-wrongbook-tag' }, '正确答案')
                        : null,
                      optionIndex === Number(item.chosen) ? h('span', { className: 'ls-wrongbook-tag ls-wrongbook-tag-wrong' }, '你的选择') : null,
                    ),
                  ),
                  item.explanation !== ''
                    ? h('div', { className: 'ls-wrongbook-explain' }, h('span', { className: 'ls-wrongbook-explain-label' }, '解析'), item.explanation)
                    : null,
                  (item.concepts || []).length > 0
                    ? h(
                        'div',
                        { className: 'ls-wrongbook-concepts' },
                        item.concepts.map((name) => h('span', { key: name, className: 'ls-chip' }, name)),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'ls-wrongbook-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: () => setRetrain({ item, variant: false }) },
                      item.resolved === true ? '再练一次' : '重做',
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => setRetrain({ item, variant: true }) },
                      '变式',
                    ),
                  ),
                ),
              ),
            ),
          ),
        retrain !== null
          ? h(RetrainModal, {
              course,
              item: retrain.item,
              initialVariant: retrain.variant,
              onClose: () => setRetrain(null),
              onToast,
              onRefreshDetail,
            })
          : null,
      );
    }

    function AssessmentModal({ course, stage, katexReady, prismReady, onClose, onToast, onRefreshDetail }) {
      const [phase, setPhase] = React.useState('loading');
      const [quiz, setQuiz] = React.useState(null);
      const [error, setError] = React.useState('');
      const [result, setResult] = React.useState(null);
      const [unlocked, setUnlocked] = React.useState([]);
      const [submitError, setSubmitError] = React.useState('');
      const [submitting, setSubmitting] = React.useState(false);
      const aliveRef = React.useRef(true);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      const load = React.useCallback(async () => {
        setPhase('loading');
        setError('');
        try {
          const response = await callApi('assessment', { id: course.id, stageIndex: stage.index });
          if (!aliveRef.current) return;
          if (response.assessment === null || response.assessment === undefined || !Array.isArray(response.assessment.questions)) {
            throw new Error('阶段测评内容为空');
          }
          setQuiz({ questions: response.assessment.questions });
          setPhase('ready');
        } catch (failure) {
          if (!aliveRef.current) return;
          setPhase('error');
          setError(failure && failure.message ? failure.message : '生成阶段测评失败');
        }
      }, [course.id, stage.index]);

      React.useEffect(() => {
        void load();
      }, [load]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      const submit = async (payload) => {
        setSubmitting(true);
        setSubmitError('');
        try {
          const response = await callApi('submit-assessment', {
            id: course.id,
            stageIndex: stage.index,
            answers: payload.answers,
          });
          if (!aliveRef.current) return;
          setResult(response.result !== null && response.result !== undefined ? response.result : null);
          setUnlocked(Array.isArray(response.newlyUnlocked) ? response.newlyUnlocked : []);
          if (onToast) {
            onToast({
              kind: response.result !== null && response.result !== undefined && response.result.passed ? 'success' : 'warn',
              text:
                response.result !== null && response.result !== undefined && response.result.passed
                  ? `阶段 ${stage.index + 1} 测评通过：${response.result.score}/${response.result.total}`
                  : `阶段 ${stage.index + 1} 测评未通过：${response.result !== null && response.result !== undefined ? response.result.score : 0}/${response.result !== null && response.result !== undefined ? response.result.total : 0}`,
            });
          }
          if (onRefreshDetail) onRefreshDetail();
        } catch (failure) {
          if (!aliveRef.current) return;
          setSubmitError(failure && failure.message ? failure.message : '提交阶段测评失败');
        } finally {
          if (aliveRef.current) setSubmitting(false);
        }
      };

      return h(
        'div',
        {
          className: 'ls-assess-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'ls-assess-panel' },
          h(
            'div',
            { className: 'ls-assess-head' },
            h(
              'div',
              { className: 'ls-assess-head-main' },
              h('h3', { className: 'ls-assess-title' }, `${stage.title} · 综合测评`),
              h('span', { className: 'ls-assess-range' }, `第 ${stage.startChapterIndex + 1} - ${stage.endChapterIndex + 1} 章 · 通过线 ${stage.threshold}%`),
            ),
            h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onClose, 'aria-label': '关闭' }, '✕'),
          ),
          h(
            'div',
            { className: 'ls-assess-body' },
            phase === 'loading' ? h('div', { className: 'ls-assess-loading' }, h(Spinner, null), '正在生成本阶段综合测评，通常需要 10–30 秒…') : null,
            phase === 'error'
              ? h(
                  'div',
                  { className: 'ls-assess-error' },
                  h('div', null, error),
                  h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: () => void load() }, '重试'),
                )
              : null,
            phase === 'ready' && quiz !== null
              ? h(
                  'div',
                  { className: 'ls-assess-quiz' },
                  result !== null
                    ? h(
                        'div',
                        { className: 'ls-assess-result', 'data-passed': result.passed ? '' : undefined },
                        h('div', { className: 'ls-assess-result-score' }, `${result.score} / ${result.total} · ${result.percent}%`),
                        h('div', { className: 'ls-assess-result-text' }, result.passed ? '通过阶段测评，已计入掌握度与解锁判定。' : `未达到通过线 ${stage.threshold}%，可以先复习薄弱概念再重测。`),
                        unlocked.length > 0
                          ? h('div', { className: 'ls-assess-result-unlock' }, `已解锁：${unlocked.map((index) => `第 ${index + 1} 章`).join('、')}`)
                          : null,
                      )
                    : null,
                  submitError !== '' ? h('div', { className: 'ls-assess-submit-error' }, submitError) : null,
                  h(QuizPanel, {
                    quiz,
                    lastResult:
                      stage.result !== null && stage.result !== undefined
                        ? { score: stage.result.score, total: stage.result.total, at: stage.result.at }
                        : null,
                    title: `${stage.title} 综合测评`,
                    onSubmit: (payload) => void submit(payload),
                  }),
                  submitting ? h('div', { className: 'ls-hint' }, '正在提交并计算掌握度…') : null,
                )
              : null,
          ),
        ),
      );
    }

    function MasteryPanel({ course, progressEntry, onGoChapter, onToast, onRefreshDetail, katexReady, prismReady }) {
      const mastery = masteryOf(course);
      if (mastery === null || mastery.chapters.length === 0) {
        return h(
          'div',
          { className: 'ls-empty' },
          h(BookIcon, { size: 36 }),
          h('div', { className: 'ls-empty-title' }, '暂无掌握度数据'),
          h('p', { className: 'ls-empty-text' }, '完成章末测验后，这里会显示课程总体掌握度、逐章概念掌握情况与薄弱概念。'),
        );
      }
      const curriculum = curriculumOf(course);
      const unlocked = new Set(curriculum.unlocked);
      const chapters = mastery.chapters;
      const generatedSet = new Set(
        (Array.isArray(course.chapters) ? course.chapters : [])
          .map((chapter, index) => (chapter !== null && chapter !== undefined ? index : null))
          .filter((index) => index !== null),
      );
      const canOpen = (index) => unlocked.has(index) && generatedSet.has(index);
      const weakest = mastery.weakest.slice(0, 5);
      const doubts = Array.isArray(course.doubts) ? course.doubts : [];
      const certificate = course.certificate !== null && course.certificate !== undefined ? course.certificate : null;
      const plan = Array.isArray(course.plan) ? course.plan : [];
      const [feedbackBusy, setFeedbackBusy] = React.useState(false);
      const [assessmentStage, setAssessmentStage] = React.useState(null);
      const stages = Array.isArray(curriculum.stages) ? curriculum.stages : [];

      const conceptChapterIndex = (conceptName) => {
        const found = mastery.chapters.find((chapter) => chapter.concepts.some((concept) => concept.name === conceptName));
        return found === undefined ? 0 : found.index;
      };

      const markUnderstood = async (conceptName) => {
        setFeedbackBusy(true);
        try {
          await callApi('feedback', { id: course.id, chapterIndex: conceptChapterIndex(conceptName), conceptName, assessment: 'understood' });
          if (onToast) onToast({ kind: 'success', text: `已标记「${conceptName}」为已理解` });
          if (onRefreshDetail) onRefreshDetail();
        } catch (error) {
          if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '更新失败' });
        } finally {
          setFeedbackBusy(false);
        }
      };

      return h(
        'div',
        { className: 'ls-mastery' },
        h(
          'div',
          { className: 'ls-mastery-overview' },
          h(
            'div',
            { className: 'ls-mastery-overview-main' },
            h('span', { className: 'ls-mastery-number' }, `${mastery.overall}%`),
            h('span', { className: 'ls-mastery-label' }, '课程掌握度'),
          ),
          h('p', { className: 'ls-mastery-caption' }, '口径：概念累计正确率（答对次数 / 作答次数），只统计已作答概念。'),
          h(ProgressBar, { value: mastery.overall, total: 100, tone: 'success' }),
        ),
        h(UnlockRequirements, { curriculum }),
        plan.length > 0
          ? h(
              'div',
              { className: 'ls-mastery-section ls-plan-section' },
              h('h3', { className: 'ls-mastery-section-title' }, '今日学习计划'),
              h(
                'div',
                { className: 'ls-plan-list' },
                plan.map((item, index) =>
                  h(
                    'div',
                    { key: `${item.type}-${index}`, className: 'ls-plan-item', 'data-type': item.type },
                    h('span', { className: 'ls-plan-type' }, PLAN_LABELS[item.type] || '任务'),
                    h('div', { className: 'ls-plan-main' }, h('div', { className: 'ls-plan-title' }, item.title), item.detail ? h('div', { className: 'ls-plan-detail' }, item.detail) : null),
                  ),
                ),
              ),
            )
          : null,
        stages.length > 0
          ? h(
              'div',
              { className: 'ls-mastery-section' },
              h('h3', { className: 'ls-mastery-section-title' }, '阶段测评'),
              h(
                'div',
                { className: 'ls-stage-list' },
                stages.map((stage) => {
                  const status = stage.result !== null && stage.result !== undefined
                    ? stage.result.passed
                      ? `已通过 ${stage.result.percent}%`
                      : `未通过 ${stage.result.percent}%`
                    : stage.available
                      ? '可测评'
                      : '未解锁';
                  return h(
                    'div',
                    { key: stage.index, className: 'ls-stage-card', 'data-status': stage.result !== null && stage.result !== undefined ? (stage.result.passed ? 'passed' : 'failed') : stage.available ? 'available' : 'locked' },
                    h(
                      'div',
                      { className: 'ls-stage-main' },
                      h('div', { className: 'ls-stage-title-row' }, h('span', { className: 'ls-stage-title' }, stage.title), h('span', { className: 'ls-stage-badge' }, status)),
                      h('div', { className: 'ls-stage-meta' }, `第 ${stage.startChapterIndex + 1} - ${stage.endChapterIndex + 1} 章 · 通过线 ${stage.threshold}%`),
                      stage.chapterTitles.length > 0 ? h('div', { className: 'ls-stage-chapters' }, stage.chapterTitles.join(' · ')) : null,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ls-btn ls-btn-sm ls-btn-primary',
                        disabled: !stage.available,
                        title: stage.available ? '' : '先解锁本阶段全部章节',
                        onClick: () => setAssessmentStage(stage),
                      },
                      stage.result !== null && stage.result !== undefined ? '重新测评' : '开始测评',
                    ),
                  );
                }),
              ),
            )
          : null,
        certificate !== null
          ? h(
              'div',
              { className: 'ls-cert-card', 'data-eligible': certificate.eligible ? '' : undefined },
              h('div', { className: 'ls-cert-title' }, certificate.eligible ? '🎓 已达成结课/证书资格' : '结课进度'),
              h(
                'div',
                { className: 'ls-cert-meta' },
                `课程掌握度 ${certificate.overall}% / 门槛 ${certificate.threshold}% · 完成 ${certificate.completedChapters}/${certificate.totalChapters} 章` +
                  (certificate.lostDoubts > 0 ? ` · 还有 ${certificate.lostDoubts} 个“没懂”概念` : ''),
              ),
              certificate.eligible ? null : h('div', { className: 'ls-cert-hint' }, '全部章节完成、掌握度达标且没有“没懂”概念即可达成。'),
            )
          : null,
        doubts.length > 0
          ? h(
              'div',
              { className: 'ls-mastery-section' },
              h('h3', { className: 'ls-mastery-section-title' }, '存疑概念'),
              h(
                'div',
                { className: 'ls-doubt-list' },
                doubts.map((doubt) =>
                  h(
                    'div',
                    { key: doubt.name, className: 'ls-doubt-item' },
                    h('span', { className: 'ls-doubt-badge', 'data-level': doubt.selfAssessment }, doubt.selfAssessment === 'lost' ? '没懂' : '模糊'),
                    h('span', { className: 'ls-doubt-name', title: doubt.name }, doubt.name),
                    h('span', { className: 'ls-doubt-score' }, `有效掌握度 ${doubt.mastery}%`),
                    h(
                      'button',
                      { type: 'button', className: 'ls-btn ls-btn-sm', disabled: feedbackBusy, onClick: () => void markUnderstood(doubt.name) },
                      '已理解',
                    ),
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'ls-mastery-section' },
          h('h3', { className: 'ls-mastery-section-title' }, '逐章掌握度'),
          h(
            'div',
            { className: 'ls-mastery-chapters' },
            chapters.map((chapter) => {
              const openable = canOpen(chapter.index);
              return h(
                'div',
                {
                  key: chapter.index,
                  className: 'ls-mastery-chapter',
                  'data-locked': unlocked.has(chapter.index) ? undefined : '',
                },
                h(
                  'div',
                  { className: 'ls-mastery-chapter-head' },
                  h(
                    'div',
                    { className: 'ls-mastery-chapter-title-wrap' },
                    h(
                      'span',
                      { className: 'ls-mastery-chapter-title' },
                      unlocked.has(chapter.index) ? null : h(LockIcon, { size: 12 }),
                      `第 ${chapter.index + 1} 章 · ${chapter.title}`,
                    ),
                    h(
                      'span',
                      { className: 'ls-mastery-chapter-meta' },
                      `${chapter.done ? '已学完' : '未学完'} · ${chapter.generated ? '已生成' : '未生成'}`,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ls-mastery-chapter-scores' },
                    h('span', { className: 'ls-mastery-score' }, h('span', { className: 'ls-mastery-score-value' }, `${chapter.mastery}%`), h('span', { className: 'ls-mastery-score-label' }, '掌握度')),
                    h('span', { className: 'ls-mastery-score' }, h('span', { className: 'ls-mastery-score-value' }, quizScoreLabel(chapter.quizScore)), h('span', { className: 'ls-mastery-score-label' }, '测验')),
                    openable
                      ? h(
                          'button',
                          { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => onGoChapter(chapter.index) },
                          '阅读',
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'ls-btn ls-btn-sm',
                            disabled: true,
                            title: unlocked.has(chapter.index) ? '该章尚未生成，无法阅读' : unlockHintFor(course, chapter.index),
                          },
                          '阅读',
                        ),
                  ),
                ),
                chapter.concepts.length > 0
                  ? h(
                      'div',
                      { className: 'ls-mastery-concepts' },
                      chapter.concepts.map((concept) =>
                        h(
                          'span',
                          {
                            key: concept.name,
                            className: 'ls-mastery-concept',
                            'data-untested': concept.attempts === 0 ? '' : undefined,
                            title: concept.attempts === 0 ? `${concept.name}（尚未测验）` : `${concept.name}：${concept.mastery}%（${concept.correct}/${concept.attempts}）`,
                          },
                          h('span', { className: 'ls-mastery-concept-name' }, concept.name),
                          concept.selfAssessment === 'lost' ? h('span', { className: 'ls-mastery-concept-flag' }, '没懂') : null,
                          concept.selfAssessment === 'unsure' ? h('span', { className: 'ls-mastery-concept-flag' }, '模糊') : null,
                          h(
                            'span',
                            { className: 'ls-mastery-concept-score' },
                            concept.attempts === 0 ? '未测' : `${concept.mastery}%`,
                          ),
                        ),
                      ),
                    )
                  : h('div', { className: 'ls-mastery-empty-line' }, '本章暂无概念数据'),
              );
            }),
          ),
        ),
        h(
          'div',
          { className: 'ls-mastery-section' },
          h('h3', { className: 'ls-mastery-section-title' }, '最薄弱概念 Top 5'),
          weakest.length === 0
            ? h('p', { className: 'ls-hint' }, '还没有可排序的测验数据，先完成章节测验吧。')
            : h(
                'div',
                { className: 'ls-weakest-list' },
                weakest.map((concept) => {
                  const openable =
                    Number.isInteger(concept.chapterIndex) &&
                    unlocked.has(concept.chapterIndex) &&
                    generatedSet.has(concept.chapterIndex);
                  return h(
                    'div',
                    { key: `${concept.chapterIndex}-${concept.name}`, className: 'ls-weakest-item' },
                    h(
                      'div',
                      { className: 'ls-weakest-main' },
                      h('span', { className: 'ls-weakest-name' }, concept.name),
                      h(
                        'span',
                        { className: 'ls-weakest-meta' },
                        `第 ${Number.isInteger(concept.chapterIndex) ? concept.chapterIndex + 1 : '?'} 章${concept.chapterTitle ? ` · ${concept.chapterTitle}` : ''} · 掌握度 ${concept.mastery}%`,
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ls-btn ls-btn-sm',
                        disabled: !openable,
                        title: openable
                          ? '跳到该章阅读'
                          : Number.isInteger(concept.chapterIndex) && !unlocked.has(concept.chapterIndex)
                            ? unlockHintFor(course, concept.chapterIndex)
                            : '该章尚未生成，无法阅读',
                        onClick: () => {
                          if (openable && Number.isInteger(concept.chapterIndex)) onGoChapter(concept.chapterIndex);
                        },
                      },
                      '去阅读',
                    ),
                  );
                }),
              ),
        ),
        h('p', { className: 'ls-hint' }, '掌握度由服务端根据测验作答计算；相同概念多次作答会累计正确率。'),
        assessmentStage !== null
          ? h(AssessmentModal, {
              course,
              stage: assessmentStage,
              katexReady,
              prismReady,
              onClose: () => setAssessmentStage(null),
              onToast,
              onRefreshDetail,
            })
          : null,
      );
    }

    function RecordsPanel({ course, onGoChapter, katexReady, prismReady }) {
      const [phase, setPhase] = React.useState('loading');
      const [interactions, setInteractions] = React.useState([]);
      const [annotations, setAnnotations] = React.useState([]);
      const [error, setError] = React.useState('');
      const [expanded, setExpanded] = React.useState(null);
      const outlines = Array.isArray(course.outline) ? course.outline : [];

      React.useEffect(() => {
        let alive = true;
        setPhase('loading');
        setError('');
        Promise.all([callApi('interactions', { id: course.id }), callApi('annotations', { id: course.id })])
          .then(([interactionResult, annotationResult]) => {
            if (!alive) return;
            const interactionItems = Array.isArray(interactionResult.items) ? interactionResult.items : [];
            const annotationItems = Array.isArray(annotationResult.items) ? annotationResult.items : [];
            setInteractions(interactionItems.slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt)));
            setAnnotations(annotationItems.slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt)));
            setPhase('ready');
          })
          .catch((failure) => {
            if (!alive) return;
            setPhase('error');
            setError(failure && failure.message ? failure.message : '加载记录失败');
          });
        return () => {
          alive = false;
        };
      }, [course.id]);

      const chapterTitle = (index) => {
        const item = outlines[index];
        return item !== undefined && item !== null && typeof item.title === 'string' ? item.title : `第 ${Number(index) + 1} 章`;
      };

      if (phase === 'loading') {
        return h('div', { className: 'ls-loading' }, h(Spinner, null), '正在加载学习记录…');
      }
      if (phase === 'error') {
        return h('div', { className: 'ls-empty' }, h(BookIcon, { size: 36 }), h('div', { className: 'ls-empty-title' }, '记录加载失败'), h('p', { className: 'ls-empty-text' }, error));
      }
      if (interactions.length === 0 && annotations.length === 0) {
        return h(
          'div',
          { className: 'ls-empty' },
          h(BookIcon, { size: 36 }),
          h('div', { className: 'ls-empty-title' }, '还没有学习记录'),
          h('p', { className: 'ls-empty-text' }, '在阅读器里划词解释、辨析、画图，或添加高亮/下划线/备注，记录会汇总到这里。'),
        );
      }

      return h(
        'div',
        { className: 'ls-records' },
        h('p', { className: 'ls-hint' }, `讨论记录 ${interactions.length} 条 · 标注 ${annotations.length} 条。讨论记录保留题目与回答，标注保留原文与备注。`),
        h(
          'section',
          { className: 'ls-records-section' },
          h('h3', { className: 'ls-records-title' }, '讨论记录'),
          interactions.length === 0
            ? h('p', { className: 'ls-hint' }, '暂无讨论记录。')
            : interactions.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'ls-record-item' },
                  h(
                    'div',
                    { className: 'ls-record-row' },
                    h('span', { className: 'ls-record-kind' }, INTERACTION_TITLES[item.kind] || '互动'),
                    h('span', { className: 'ls-record-chapter' }, chapterTitle(item.chapterIndex)),
                    item.conceptName ? h('span', { className: 'ls-record-concept' }, item.conceptName) : null,
                    h('span', { className: 'ls-record-time' }, formatRelativeTime(item.createdAt)),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ls-btn ls-btn-sm',
                        onClick: () => setExpanded((value) => (value === item.id ? null : item.id)),
                      },
                      expanded === item.id ? '收起' : '查看',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ls-record-selection' },
                    item.selection !== '' ? item.selection : item.question !== '' ? `追问：${item.question}` : '（未记录原文）',
                  ),
                  expanded === item.id
                    ? h(
                        'div',
                        { className: 'ls-record-answer' },
                        typeof item.svg === 'string' && item.svg !== ''
                          ? h(SvgFigure, { source: item.svg })
                          : h(MarkdownView, { markdown: item.answer || '', katexReady: katexReady === true, prismReady: prismReady === true }),
                      )
                    : null,
                ),
              ),
        ),
        h(
          'section',
          { className: 'ls-records-section' },
          h('h3', { className: 'ls-records-title' }, '阅读标注'),
          annotations.length === 0
            ? h('p', { className: 'ls-hint' }, '暂无标注记录。')
            : annotations.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'ls-record-ann' },
                  h('span', { className: 'ls-record-ann-color', 'data-color': item.color || 'yellow', title: ANNOTATION_COLOR_LABELS[item.color] || '标注' }),
                  h(
                    'span',
                    {
                      className: 'ls-record-ann-style',
                      'data-style': item.style === 'underline' ? 'underline' : 'highlight',
                      title: item.style === 'underline' ? '下划线' : '高亮',
                    },
                    item.style === 'underline' ? h(UnderlineIcon, { size: 13 }) : h(HighlightIcon, { size: 13 }),
                  ),
                  h(
                    'div',
                    { className: 'ls-record-ann-main' },
                    h('div', { className: 'ls-record-ann-quote' }, item.quote.length > 140 ? `${item.quote.slice(0, 140)}…` : item.quote),
                    (Array.isArray(item.notes) ? item.notes : item.note ? [{ id: 'legacy', text: item.note }] : []).map((note) =>
                      h('div', { key: note.id, className: 'ls-record-ann-note' }, `备注：${note.text}`),
                    ),
                    h('div', { className: 'ls-record-ann-meta' }, `${chapterTitle(item.chapterIndex)} · ${formatRelativeTime(item.createdAt)}`),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => onGoChapter(item.chapterIndex) },
                    '去原文',
                  ),
                ),
              ),
        ),
      );
    }

    function PlanPanel({ course, onToast, onRefreshDetail }) {
      const outline = Array.isArray(course.outline) ? course.outline : [];
      const suggestions = Array.isArray(course.plan) ? course.plan : [];
      const [items, setItems] = React.useState(() => (Array.isArray(course.studyPlan) ? course.studyPlan : []));
      const [title, setTitle] = React.useState('');
      const [detail, setDetail] = React.useState('');
      const [chapterIndex, setChapterIndex] = React.useState('');
      const [dueInput, setDueInput] = React.useState(() => toDateTimeLocalValue(Date.now() + 2 * 60 * 60 * 1000));
      const [busy, setBusy] = React.useState(false);
      const canNotify = typeof window !== 'undefined' && typeof window.Notification === 'function';
      const [permission, setPermission] = React.useState(() =>
        canNotify ? window.Notification.permission : 'unsupported',
      );

      React.useEffect(() => {
        setItems(Array.isArray(course.studyPlan) ? course.studyPlan : []);
      }, [course.studyPlan]);

      const now = Date.now();
      const pending = items.filter((item) => item.status === 'pending').sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
      const overdue = pending.filter((item) => Number(item.dueAt) > 0 && Number(item.dueAt) < now);
      const dueToday = pending.filter(
        (item) => Number(item.dueAt) >= now && Number(item.dueAt) > 0 && sameDay(new Date(Number(item.dueAt)), new Date(now)),
      );
      const upcoming = pending.filter(
        (item) => Number(item.dueAt) > 0 && Number(item.dueAt) >= now && !sameDay(new Date(Number(item.dueAt)), new Date(now)),
      );
      const done = items
        .filter((item) => item.status === 'done')
        .sort((a, b) => Number(b.completedAt) - Number(a.completedAt));

      const apply = async (action, payload) => {
        setBusy(true);
        try {
          const response = await callApi(action, { id: course.id, ...payload });
          if (Array.isArray(response.studyPlan)) setItems(response.studyPlan);
          if (onRefreshDetail) onRefreshDetail();
          return true;
        } catch (failure) {
          if (onToast) onToast({ kind: 'error', text: failure && failure.message ? failure.message : '操作失败' });
          return false;
        } finally {
          setBusy(false);
        }
      };

      const addTask = async () => {
        const trimmed = title.trim();
        if (trimmed === '') {
          if (onToast) onToast({ kind: 'warn', text: '先填写任务标题' });
          return;
        }
        const dueAt = parseDateTimeLocal(dueInput);
        const ok = await apply('plan-add', {
          title: trimmed,
          detail: detail.trim(),
          dueAt: Number.isFinite(dueAt) ? dueAt : Date.now() + 60 * 60 * 1000,
          chapterIndex: chapterIndex === '' ? null : Number(chapterIndex),
        });
        if (ok) {
          setTitle('');
          setDetail('');
          setChapterIndex('');
          if (onToast) onToast({ kind: 'success', text: '已加入学习计划' });
        }
      };

      const toggleTask = async (item) => {
        const ok = await apply('plan-update', { itemId: item.id, status: item.status === 'done' ? 'pending' : 'done' });
        if (ok && onToast) onToast({ kind: 'success', text: item.status === 'done' ? '已恢复为待办' : '已完成，继续保持' });
      };

      const changeDue = async (item, value) => {
        const dueAt = parseDateTimeLocal(value);
        if (!Number.isFinite(dueAt)) return;
        await apply('plan-update', { itemId: item.id, dueAt });
      };

      const removeTask = async (item) => {
        const ok = await apply('plan-delete', { itemId: item.id });
        if (ok && onToast) onToast({ kind: 'success', text: '已删除计划任务' });
      };

      const fillSuggestion = (suggestion) => {
        setTitle(suggestion.title || '');
        setDetail(suggestion.detail || '');
        setChapterIndex(Number.isInteger(suggestion.chapterIndex) ? String(suggestion.chapterIndex) : '');
        if (onToast) onToast({ kind: 'info', text: '已填入表单，设置截止时间后点「添加任务」' });
      };

      const requestNotifications = async () => {
        if (!canNotify) {
          if (onToast) onToast({ kind: 'warn', text: '当前环境不支持系统通知' });
          return;
        }
        try {
          const result = await window.Notification.requestPermission();
          setPermission(result);
          if (onToast) {
            onToast({
              kind: result === 'granted' ? 'success' : 'warn',
              text: result === 'granted' ? '已开启桌面提醒：任务到期时会弹系统通知' : '未获得通知权限，仍会在页面内提醒',
            });
          }
        } catch (error) {
          if (onToast) onToast({ kind: 'warn', text: '开启通知失败，仍会在页面内提醒' });
        }
      };

      const taskRow = (item) => {
        const isDone = item.status === 'done';
        return h(
          'div',
          { key: item.id, className: 'ls-plan-task', 'data-done': isDone ? '' : undefined },
          h('input', {
            type: 'checkbox',
            className: 'ls-plan-check',
            checked: isDone,
            'aria-label': isDone ? '恢复为待办' : '标记完成',
            onChange: () => void toggleTask(item),
            disabled: busy,
          }),
          h(
            'div',
            { className: 'ls-plan-task-main' },
            h('div', { className: 'ls-plan-task-title' }, item.title),
            item.detail !== '' ? h('div', { className: 'ls-plan-task-detail' }, item.detail) : null,
            h(
              'div',
              { className: 'ls-plan-task-meta' },
              item.chapterIndex !== null && item.chapterIndex !== undefined ? `${outlineTitle(course, item.chapterIndex)} · ` : '',
              isDone ? `完成于 ${formatRelativeTime(item.completedAt)}` : `截止 ${formatDateTime(item.dueAt)}`,
            ),
          ),
          isDone
            ? null
            : h('input', {
                type: 'datetime-local',
                className: 'ls-input ls-plan-task-date',
                value: toDateTimeLocalValue(item.dueAt),
                'aria-label': '修改截止时间',
                disabled: busy,
                onChange: (event) => void changeDue(item, event.target.value),
              }),
          h(
            'button',
            { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', disabled: busy, onClick: () => void removeTask(item) },
            '删除',
          ),
        );
      };

      const group = (label, list, emptyText) =>
        list.length > 0
          ? h(
              'section',
              { className: 'ls-plan-group' },
              h('h3', { className: 'ls-plan-group-title' }, label),
              list.map(taskRow),
            )
          : emptyText
            ? h('div', { className: 'ls-hint' }, emptyText)
            : null;

      return h(
        'div',
        { className: 'ls-plan' },
        h(
          'div',
          { className: 'ls-plan-summary' },
          h('div', { className: 'ls-plan-summary-main' }, h('span', { className: 'ls-plan-summary-number' }, String(pending.length)), h('span', { className: 'ls-plan-summary-label' }, '待办任务')),
          h(
            'div',
            { className: 'ls-plan-summary-meta' },
            `逾期 ${overdue.length} · 今天 ${dueToday.length} · 已完成 ${done.length}`,
          ),
          canNotify
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-sm',
                  onClick: () => void requestNotifications(),
                  disabled: permission === 'granted' || permission === 'denied',
                },
                permission === 'granted' ? '桌面提醒已开启' : permission === 'denied' ? '桌面通知被拒绝（页面内仍提醒）' : '开启桌面提醒',
              )
            : null,
        ),
        overdue.length > 0 || dueToday.length > 0
          ? h(
              'div',
              { className: 'ls-plan-reminder' },
              h('span', { className: 'ls-plan-reminder-dot' }),
              h(
                'span',
                null,
                overdue.length > 0
                  ? `有 ${overdue.length} 个任务已逾期${dueToday.length > 0 ? `，今天还有 ${dueToday.length} 个到期` : ''}`
                  : `今天有 ${dueToday.length} 个任务到期`,
              ),
            )
          : null,
        h(
          'section',
          { className: 'ls-plan-form' },
          h('h3', { className: 'ls-plan-group-title' }, '添加任务'),
          h(
            'div',
            { className: 'ls-plan-form-grid' },
            h('input', {
              className: 'ls-input',
              placeholder: '任务内容，例如：复习第 2 章、补强「反电动势」',
              value: title,
              onChange: (event) => setTitle(event.target.value),
              disabled: busy,
            }),
            h('input', {
              type: 'datetime-local',
              className: 'ls-input',
              value: dueInput,
              'aria-label': '截止时间',
              onChange: (event) => setDueInput(event.target.value),
              disabled: busy,
            }),
            h(
              'select',
              {
                className: 'ls-select',
                value: chapterIndex,
                'aria-label': '关联章节',
                onChange: (event) => setChapterIndex(event.target.value),
                disabled: busy,
              },
              h('option', { value: '' }, '不关联章节'),
              outline.map((item, index) => h('option', { key: index, value: String(index) }, `第 ${index + 1} 章 · ${item.title || ''}`)),
            ),
          ),
          h('input', {
            className: 'ls-input',
            placeholder: '备注（可选）',
            value: detail,
            onChange: (event) => setDetail(event.target.value),
            disabled: busy,
          }),
          h(
            'div',
            { className: 'ls-plan-form-actions' },
            h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: () => void addTask(), disabled: busy || title.trim() === '' }, '添加任务'),
          ),
        ),
        suggestions.length > 0
          ? h(
              'section',
              { className: 'ls-plan-suggestions' },
              h('h3', { className: 'ls-plan-group-title' }, '建议任务'),
              h(
                'div',
                { className: 'ls-plan-suggestion-list' },
                suggestions.map((suggestion, index) =>
                  h(
                    'div',
                    { key: `${suggestion.type}-${index}`, className: 'ls-plan-suggestion' },
                    h('span', { className: 'ls-plan-suggestion-type' }, PLAN_LABELS[suggestion.type] || '任务'),
                    h('div', { className: 'ls-plan-suggestion-main' }, h('div', { className: 'ls-plan-suggestion-title' }, suggestion.title), suggestion.detail ? h('div', { className: 'ls-plan-suggestion-detail' }, suggestion.detail) : null),
                    h('button', { type: 'button', className: 'ls-btn ls-btn-sm', onClick: () => fillSuggestion(suggestion) }, '填入计划'),
                  ),
                ),
              ),
            )
          : null,
        group('逾期', overdue, null),
        group('今天', dueToday, null),
        group('未来', upcoming, pending.length === 0 ? '还没有计划任务，先添加一个吧。' : null),
        group('已完成', done, null),
      );
    }

    function CourseDetailPanel({
      course,
      progressEntry,
      generation,
      activeChapter,
      tab,
      reviewDue,
      graphBusy,
      onTabChange,
      onGenerateAll,
      onGenerateChapter,
      onRead,
      onGoChapter,
      onGenerateGraph,
      onStartReview,
      onToast,
      onRefreshDetail,
      katexReady,
      prismReady,
    }) {
      const stats = courseStats(course);
      const entry = normalizeProgressEntry(progressEntry);
      const doneSet = new Set(entry.done.filter((index) => index >= 0 && index < stats.total));
      const running = Boolean(generation && generation.running);
      const mastery = masteryOf(course);
      const hasMastery = mastery !== null && mastery.chapters.length > 0;
      const wrongBook = Array.isArray(course.wrongBook) ? course.wrongBook : [];
      const hasWrongBook = wrongBook.length > 0;
      const wrongBookUnresolved = wrongBook.filter((item) => item !== null && item !== undefined && item.resolved !== true).length;
      const planDueCount = (Array.isArray(course.studyPlan) ? course.studyPlan : []).filter(
        (item) => item !== null && item !== undefined && item.status === 'pending' && Number(item.dueAt) > 0 && Number(item.dueAt) <= Date.now(),
      ).length;
      const curriculum = curriculumOf(course);
      const activeTab =
        tab === 'graph' ||
        tab === 'review' ||
        (tab === 'mastery' && hasMastery) ||
        (tab === 'wrongbook' && hasWrongBook) ||
        tab === 'records' ||
        tab === 'plan'
          ? tab
          : 'chapters';
      const dueCount = Number.isFinite(Number(reviewDue)) ? Math.max(0, Number(reviewDue)) : 0;
      const now = Date.now();
      const graphAvailable = course.graph !== null && course.graph !== undefined;
      const openMissing = stats.missing.filter((index) => chapterIsUnlocked(course, index));
      const unlockedCount = unlockedCountOf(course);
      const showUnlock = !curriculum.legacy && stats.total > 0;

      const tabButton = (value, label, badge) =>
        h(
          'button',
          {
            type: 'button',
            className: 'ls-tab',
            'data-active': activeTab === value ? '' : undefined,
            onClick: () => onTabChange(value),
          },
          label,
          badge !== null && badge !== undefined ? h('span', { className: 'ls-tab-badge' }, String(badge)) : null,
        );

      let body;
      if (activeTab === 'chapters') {
        body = h(ChapterList, {
          course,
          progressEntry: entry,
          generation,
          activeChapter,
          running,
          graphBusy: graphBusy === true,
          onGenerateChapter,
          onRead,
        });
      } else if (activeTab === 'graph') {
        body = h(GraphPanel, {
          graph: course.graph,
          chapters: Array.isArray(course.chapters) ? course.chapters : [],
          curriculum: course.curriculum,
          busy: graphBusy,
          disabled: running,
          onGenerate: onGenerateGraph,
          onGoChapter,
        });
      } else if (activeTab === 'mastery') {
        body = h(MasteryPanel, { course, progressEntry: entry, onGoChapter, onToast, onRefreshDetail, katexReady, prismReady });
      } else if (activeTab === 'wrongbook') {
        body = h(WrongBookPanel, { course, onGoChapter, onToast, onRefreshDetail });
      } else if (activeTab === 'records') {
        body = h(RecordsPanel, { course, onGoChapter, katexReady, prismReady });
      } else if (activeTab === 'plan') {
        body = h(PlanPanel, { course, onToast, onRefreshDetail });
      } else {
        body = h(ReviewPanel, {
          course,
          progressEntry: entry,
          now,
          onStartReview,
        });
      }

      const generateAllLabel =
        openMissing.length === 0
          ? stats.missing.length === 0
            ? '已全部生成'
            : '等待解锁'
          : '生成全部章节';

      return h(
        'div',
        { className: 'ls-panel' },
        h(
          'div',
          { className: 'ls-detail-head' },
          h(
            'div',
            { className: 'ls-detail-title-row' },
            h(
              'div',
              { className: 'ls-detail-title-wrap' },
              h('h2', { className: 'ls-detail-title' }, course.title || '未命名课程'),
              h(
                'div',
                { className: 'ls-tags' },
                h(Tag, { tone: 'domain' }, DOMAIN_LABELS[course.domain] || DOMAIN_LABELS.general),
                h(Tag, { tone: 'level' }, LEVEL_LABELS[course.level] || LEVEL_LABELS.beginner),
                dueCount > 0 ? h(Tag, { tone: 'warn' }, `待复习 ${dueCount}`) : null,
                graphAvailable ? h(Tag, { tone: 'level' }, '已生成图谱') : null,
                showUnlock ? h(Tag, { tone: 'level' }, `已解锁 ${unlockedCount} / ${stats.total} 章`) : null,
                stats.total > 0 && stats.generatedCount >= stats.total
                  ? h(Tag, { tone: 'success' }, '已全部生成')
                  : stats.generatedCount > 0
                    ? h(Tag, { tone: 'warn' }, '生成中')
                    : h(Tag, { tone: 'idle' }, '待生成'),
              ),
            ),
            activeTab === 'chapters'
              ? h(
                  'div',
                  { className: 'ls-detail-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ls-btn ls-btn-primary',
                      onClick: onGenerateAll,
                      disabled: running || graphBusy === true || openMissing.length === 0,
                      title:
                        openMissing.length === 0
                          ? stats.missing.length === 0
                            ? '所有章节均已生成'
                            : '等待已解锁章节满足解锁条件'
                          : '从第一个已解锁且未生成的章节开始，串行生成全部章节',
                    },
                    running ? h(Spinner, null) : null,
                    generateAllLabel,
                  ),
                )
              : null,
          ),
          h(
            'div',
            { className: 'ls-detail-meta' },
            h('span', null, `已生成 ${stats.generatedCount} / ${stats.total} 章`),
            h('span', { className: 'ls-dot', 'aria-hidden': true }, '·'),
            h('span', null, `已学完 ${doneSet.size} / ${stats.total} 章`),
            showUnlock ? h('span', { className: 'ls-dot', 'aria-hidden': true }, '·') : null,
            showUnlock ? h('span', null, `已解锁 ${unlockedCount} / ${stats.total} 章`) : null,
            dueCount > 0 ? h('span', { className: 'ls-dot', 'aria-hidden': true }, '·') : null,
            dueCount > 0 ? h('span', null, `待复习 ${dueCount} 章`) : null,
            h('span', { className: 'ls-dot', 'aria-hidden': true }, '·'),
            h('span', null, `更新于 ${formatRelativeTime(course.updatedAt)}`),
          ),
          h(ProgressBar, { value: stats.generatedCount, total: stats.total }),
        ),
        h(
          'div',
          { className: 'ls-tabs', role: 'tablist' },
          tabButton('chapters', '章节', null),
          tabButton('graph', '知识图谱', null),
          tabButton('review', '复习', dueCount > 0 ? dueCount : null),
          hasMastery ? tabButton('mastery', '掌握度', null) : null,
          tabButton('plan', '计划', planDueCount > 0 ? planDueCount : null),
          hasWrongBook ? tabButton('wrongbook', '错题本', wrongBookUnresolved > 0 ? wrongBookUnresolved : null) : null,
          tabButton('records', '记录', null),
        ),
        h('div', { className: 'ls-detail-scroll' }, body),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Quiz panel                                                        */
    /* ---------------------------------------------------------------- */

    function QuizPanel({ quiz, lastResult, onSubmit, title, afterSubmit }) {
      const questions =
        quiz !== null && quiz !== undefined && Array.isArray(quiz.questions) ? quiz.questions.filter((question) => question !== null && typeof question === 'object') : [];
      const [answers, setAnswers] = React.useState({});
      const [submitted, setSubmitted] = React.useState(false);
      const [result, setResult] = React.useState(null);

      const quizTitle = typeof title === 'string' && title !== '' ? title : '章末测验';

      if (questions.length === 0) {
        return h(
          'section',
          { className: 'ls-quiz' },
          h('h2', { className: 'ls-quiz-title' }, quizTitle),
          h('div', { className: 'ls-quiz-empty' }, '本章暂无测验'),
        );
      }

      const answeredCount = questions.reduce(
        (count, ignored, index) => (Number.isInteger(answers[index]) ? count + 1 : count),
        0,
      );
      const allAnswered = answeredCount === questions.length;

      const submit = () => {
        if (submitted || !allAnswered) return;
        const score = questions.reduce(
          (total, question, index) => (answers[index] === Number(question.answerIndex) ? total + 1 : total),
          0,
        );
        const payload = {
          score,
          total: questions.length,
          answers: questions.map((ignored, index) => (Number.isInteger(answers[index]) ? answers[index] : -1)),
          at: Date.now(),
        };
        setResult(payload);
        setSubmitted(true);
        onSubmit(payload);
      };

      const retake = () => {
        setAnswers({});
        setSubmitted(false);
        setResult(null);
      };

      const verdict = (() => {
        if (!submitted || result === null) return '';
        const ratio = result.total === 0 ? 0 : result.score / result.total;
        if (ratio === 1) return '全部答对，这一章掌握得很扎实！';
        if (ratio >= 0.67) return '基本掌握，个别细节可以回看解析再巩固一下。';
        if (ratio >= 0.34) return '还有几个关键概念没吃透，建议重读本章相关小节。';
        return '别急，先回看本章再来一次，效果会更好。';
      })();

      return h(
        'section',
        { className: 'ls-quiz', 'aria-label': quizTitle },
        h(
          'div',
          { className: 'ls-quiz-head' },
          h('h2', { className: 'ls-quiz-title' }, quizTitle),
          submitted && result !== null
            ? h(
                'span',
                {
                  className: 'ls-quiz-score',
                  'data-good': result.score === result.total ? '' : undefined,
                  'data-bad': result.score * 2 < result.total ? '' : undefined,
                },
                `得分 ${result.score} / ${result.total}`,
              )
            : lastResult !== null && lastResult !== undefined
              ? h(
                  'span',
                  { className: 'ls-tag ls-tag-level' },
                  `上次得分 ${Number(lastResult.score) || 0} / ${Number(lastResult.total) || 0}`,
                )
              : h('span', { className: 'ls-tag ls-tag-level' }, `共 ${questions.length} 题`),
        ),
        submitted && result !== null ? h('p', { className: 'ls-quiz-verdict' }, verdict) : null,
        questions.map((question, questionIndex) => {
          const options = Array.isArray(question.options) ? question.options : [];
          const answerIndex = Number(question.answerIndex);
          const questionConcepts = Array.isArray(question.concepts)
            ? question.concepts
                .filter((concept) => typeof concept === 'string' && concept.trim() !== '')
                .map((concept) => concept.trim())
            : [];
          return h(
            'div',
            { key: questionIndex, className: 'ls-quiz-q' },
            h(
              'p',
              { className: 'ls-quiz-question' },
              h('span', { className: 'ls-quiz-q-no' }, `${questionIndex + 1}.`),
              h('span', null, typeof question.question === 'string' ? question.question : ''),
            ),
            questionConcepts.length > 0
              ? h(
                  'div',
                  { className: 'ls-quiz-concepts' },
                  h('span', { className: 'ls-quiz-concepts-label' }, '考察：'),
                  questionConcepts.map((concept) =>
                    h('span', { key: concept, className: 'ls-quiz-concept-chip', title: concept }, concept),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'ls-quiz-options', role: 'group', 'aria-label': `第 ${questionIndex + 1} 题选项` },
              options.map((option, optionIndex) => {
                const selected = answers[questionIndex] === optionIndex;
                const correct = submitted && optionIndex === answerIndex;
                const wrong = submitted && selected && optionIndex !== answerIndex;
                return h(
                  'button',
                  {
                    key: optionIndex,
                    type: 'button',
                    className: 'ls-quiz-option',
                    disabled: submitted,
                    'data-selected': !submitted && selected ? '' : undefined,
                    'data-correct': correct ? '' : undefined,
                    'data-wrong': wrong ? '' : undefined,
                    onClick: () => {
                      if (submitted) return;
                      setAnswers((previous) => ({ ...previous, [questionIndex]: optionIndex }));
                    },
                  },
                  h('span', { className: 'ls-quiz-option-mark', 'aria-hidden': true }, String.fromCharCode(65 + optionIndex)),
                  h('span', { className: 'ls-quiz-option-text' }, typeof option === 'string' ? option : String(option)),
                );
              }),
            ),
            submitted
              ? h(
                  'div',
                  { className: 'ls-quiz-explain', 'data-correct': answers[questionIndex] === answerIndex ? '' : undefined },
                  typeof question.explanation === 'string' && question.explanation !== ''
                    ? question.explanation
                    : '暂无解析。',
                )
              : null,
          );
        }),
        submitted
          ? h(
              'div',
              { className: 'ls-quiz-actions' },
              h('button', { type: 'button', className: 'ls-btn', onClick: retake }, '再做一次'),
            )
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'ls-quiz-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn ls-btn-primary',
                    onClick: submit,
                    disabled: !allAnswered,
                  },
                  '提交答案',
                ),
              ),
              allAnswered
                ? null
                : h('p', { className: 'ls-quiz-hint' }, `还有 ${questions.length - answeredCount} 题未作答`),
            ),
        submitted && afterSubmit !== undefined && afterSubmit !== null ? afterSubmit : null,
      );
    }

    /** Reading-mode quiz: collapsed by default and fully unmounted while closed. */
    function normalizeReaderConcepts(raw) {
      const list =
        raw !== null && raw !== undefined && Array.isArray(raw)
          ? raw
          : raw !== null && raw !== undefined && Array.isArray(raw.concepts)
            ? raw.concepts
            : [];
      const seen = new Set();
      const concepts = [];
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        concepts.push({
          name,
          definition: typeof item.definition === 'string' ? item.definition.trim() : '',
          prerequisites: Array.isArray(item.prerequisites)
            ? item.prerequisites.filter((value) => typeof value === 'string' && value !== '')
            : [],
          difficulty: Number.isInteger(item.difficulty) ? item.difficulty : null,
          selfAssessment:
            item.selfAssessment === 'understood' || item.selfAssessment === 'unsure' || item.selfAssessment === 'lost'
              ? item.selfAssessment
              : null,
        });
        if (concepts.length >= 12) break;
      }
      return concepts;
    }

    /** Lightweight "core concepts" card before the end-of-chapter quiz. */
    const INTERACTION_TITLES = { explain: '解释这段内容', compare: '概念辨析', figure: '重新画示意图' };

    function InteractionPanel({ course, chapterIndex, mode, selection, conceptName, katexReady, prismReady, onClose, onToast }) {
      const [messages, setMessages] = React.useState([]);
      const [phase, setPhase] = React.useState('loading');
      const [error, setError] = React.useState('');
      const [draft, setDraft] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [historyOpen, setHistoryOpen] = React.useState(false);
      const [historyLoading, setHistoryLoading] = React.useState(false);
      const aliveRef = React.useRef(true);
      const requestRef = React.useRef(0);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      React.useEffect(() => {
        let alive = true;
        setHistoryLoading(true);
        callApi('interactions', { id: course.id, chapterIndex })
          .then((result) => {
            if (!alive) return;
            setHistory(Array.isArray(result.items) ? result.items : []);
          })
          .catch(() => {
            /* history is optional */
          })
          .finally(() => {
            if (alive) setHistoryLoading(false);
          });
        return () => {
          alive = false;
        };
      }, [course.id, chapterIndex]);

      const openHistoryItem = (item) => {
        if (item === null || item === undefined) return;
        setMessages([
          {
            answer: typeof item.answer === 'string' ? item.answer : '',
            svg: typeof item.svg === 'string' ? item.svg : '',
            question: '',
          },
        ]);
        setHistoryOpen(false);
        setPhase('ready');
        setError('');
      };

      const send = React.useCallback(
        async (question) => {
          const requestId = requestRef.current + 1;
          requestRef.current = requestId;
          setPhase('loading');
          setError('');
          try {
            const result = await callApi('interact', {
              id: course.id,
              chapterIndex,
              kind: mode,
              selection: typeof selection === 'string' ? selection : '',
              conceptName: typeof conceptName === 'string' ? conceptName : '',
              question: typeof question === 'string' ? question : '',
            });
            if (!aliveRef.current || requestRef.current !== requestId) return;
            const item = result.interaction !== null && result.interaction !== undefined ? result.interaction : {};
            const message = {
              answer: typeof item.answer === 'string' ? item.answer : '',
              svg: typeof item.svg === 'string' ? item.svg : '',
              question: typeof question === 'string' ? question : '',
            };
            setMessages((previous) => (message.question === '' && previous.length === 0 ? [message] : previous.concat([message])));
            if (item !== null && item !== undefined && typeof item.id === 'string') {
              setHistory((previous) => [item, ...previous.filter((existing) => existing === null || existing === undefined || existing.id !== item.id)]);
            }
            setPhase('ready');
          } catch (failure) {
            if (!aliveRef.current || requestRef.current !== requestId) return;
            setPhase('error');
            setError(failure && failure.message ? failure.message : '互动请求失败，请重试');
          }
        },
        [course.id, chapterIndex, mode, selection, conceptName],
      );

      React.useEffect(() => {
        void send('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [mode, selection, conceptName, chapterIndex]);

      const submitFollowUp = () => {
        const question = draft.trim();
        if (question === '' || phase === 'loading') return;
        setDraft('');
        void send(question);
      };

      const retry = () => {
        void send('');
      };

      return h(
        'div',
        {
          className: 'ls-interact-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'ls-interact-panel' },
          h(
            'div',
            { className: 'ls-interact-head' },
            h('div', { className: 'ls-interact-head-main' }, h('h3', { className: 'ls-interact-title' }, INTERACTION_TITLES[mode] || '互动'), conceptName !== '' ? h('span', { className: 'ls-interact-concept' }, conceptName) : null),
            h(
              'div',
              { className: 'ls-interact-head-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-sm ls-btn-ghost',
                  onClick: () => setHistoryOpen((value) => !value),
                  disabled: historyLoading,
                },
                historyLoading ? '历史…' : `历史 ${history.length}`,
              ),
              h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onClose, 'aria-label': '关闭' }, '✕'),
            ),
          ),
          selection !== '' ? h('div', { className: 'ls-interact-selection' }, selection.length > 260 ? `${selection.slice(0, 260)}…` : selection) : null,
          h(
            'div',
            { className: 'ls-interact-body' },
            historyOpen
              ? h(
                  'div',
                  { className: 'ls-interact-history' },
                  history.length === 0
                    ? h('div', { className: 'ls-hint' }, '本章还没有历史互动记录。')
                    : history.map((item) =>
                        h(
                          'button',
                          {
                            key: item.id,
                            type: 'button',
                            className: 'ls-interact-history-item',
                            onClick: () => openHistoryItem(item),
                          },
                          h('span', { className: 'ls-interact-history-kind' }, INTERACTION_TITLES[item.kind] || '互动'),
                          h(
                            'span',
                            { className: 'ls-interact-history-main' },
                            h('span', { className: 'ls-interact-history-selection' }, (item.selection || item.question || '').slice(0, 90)),
                            h('span', { className: 'ls-interact-history-meta' }, `${formatRelativeTime(item.createdAt)}${item.conceptName ? ` · ${item.conceptName}` : ''}`),
                          ),
                        ),
                      ),
                )
              : null,
            messages.map((message, index) =>
              h(
                'div',
                { key: index, className: 'ls-interact-message' },
                message.question !== '' ? h('div', { className: 'ls-interact-question' }, `追问：${message.question}`) : null,
                message.svg !== '' ? h(SvgFigure, { source: message.svg }) : h(MarkdownView, { markdown: message.answer, katexReady: katexReady === true, prismReady: prismReady === true }),
              ),
            ),
            phase === 'loading' ? h('div', { className: 'ls-interact-loading' }, h(Spinner, null), mode === 'figure' ? '正在画示意图…' : '正在生成…') : null,
            phase === 'error'
              ? h(
                  'div',
                  { className: 'ls-interact-error' },
                  h('div', null, error !== '' ? error : '请求失败'),
                  h('button', { type: 'button', className: 'ls-btn ls-btn-sm', onClick: retry }, '重试'),
                )
              : null,
          ),
          h(
            'div',
            { className: 'ls-interact-footer' },
            mode === 'figure'
              ? h(
                  'button',
                  { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: () => void send(''), disabled: phase === 'loading' },
                  '再画一张',
                )
              : h(
                  'div',
                  { className: 'ls-interact-follow' },
                  h('textarea', {
                    className: 'ls-textarea ls-interact-input',
                    value: draft,
                    rows: 2,
                    placeholder: '继续追问（例如：再举个生活中的例子）',
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        submitFollowUp();
                      }
                    },
                  }),
                  h(
                    'button',
                    { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', onClick: submitFollowUp, disabled: phase === 'loading' || draft.trim() === '' },
                    '发送',
                  ),
                ),
          ),
        ),
      );
    }

    function ReaderConceptsSection({ concepts, onExplainConcept, onFeedbackConcept }) {
      const list = normalizeReaderConcepts(concepts);
      if (list.length === 0) return null;
      return h(
        'section',
        { className: 'ls-concepts-card', 'aria-label': '核心概念' },
        h(
          'div',
          { className: 'ls-concepts-head' },
          h('h2', { className: 'ls-concepts-title' }, '核心概念'),
          h('span', { className: 'ls-concepts-hint' }, '点击概念可解释，右侧可标记掌握状态'),
        ),
        h(
          'div',
          { className: 'ls-concepts-list' },
          list.map((concept) =>
            h(
              'span',
              {
                key: concept.name,
                className: 'ls-concept-chip',
                'data-assessment': concept.selfAssessment || undefined,
                title: concept.definition !== '' ? concept.definition : concept.name,
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-concept-chip-main',
                  onClick: () => onExplainConcept && onExplainConcept(concept.name),
                  title: concept.definition !== '' ? concept.definition : '解释这个概念',
                },
                concept.name,
              ),
              concept.selfAssessment === 'lost' ? h('span', { className: 'ls-concept-flag' }, '没懂') : null,
              concept.selfAssessment === 'unsure' ? h('span', { className: 'ls-concept-flag' }, '模糊') : null,
              h(
                'span',
                { className: 'ls-concept-actions' },
                h('button', { type: 'button', className: 'ls-concept-mini', onClick: () => onFeedbackConcept && onFeedbackConcept(concept.name, 'understood'), title: '标记为已理解' }, '✓'),
                h('button', { type: 'button', className: 'ls-concept-mini', onClick: () => onFeedbackConcept && onFeedbackConcept(concept.name, 'unsure'), title: '标记为有点模糊' }, '?'),
                h('button', { type: 'button', className: 'ls-concept-mini', onClick: () => onFeedbackConcept && onFeedbackConcept(concept.name, 'lost'), title: '标记为没懂' }, '!'),
              ),
            ),
          ),
        ),
      );
    }

    function ReaderQuizSection({ quiz, lastResult, onSubmit }) {
      const questions =
        quiz !== null && quiz !== undefined && Array.isArray(quiz.questions)
          ? quiz.questions.filter((question) => question !== null && typeof question === 'object')
          : [];
      const [open, setOpen] = React.useState(false);

      if (questions.length === 0) {
        return h(
          'section',
          { className: 'ls-quiz' },
          h('h2', { className: 'ls-quiz-title' }, '章末测验'),
          h('div', { className: 'ls-quiz-empty' }, '本章暂无测验'),
        );
      }

      const lastScore =
        lastResult !== null && lastResult !== undefined
          ? `${Number(lastResult.score) || 0} / ${Number(lastResult.total) || 0}`
          : '';

      return h(
        'section',
        { className: 'ls-quiz-fold' },
        h(
          'button',
          {
            type: 'button',
            className: 'ls-quiz-fold-head',
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open ? 'true' : 'false',
          },
          h('span', { className: 'ls-quiz-fold-title' }, '章末测验'),
          h('span', { className: 'ls-quiz-fold-meta' }, `共 ${questions.length} 题`),
          lastScore !== '' ? h('span', { className: 'ls-quiz-fold-score' }, `上次 ${lastScore}`) : null,
          h(
            'span',
            { className: 'ls-quiz-fold-chevron', 'data-open': open ? '' : undefined, 'aria-hidden': true },
            '▸',
          ),
        ),
        open ? h('div', { className: 'ls-quiz-fold-body' }, h(QuizPanel, { quiz, lastResult, onSubmit })) : null,
      );
    }

    /* ---------------------------------------------------------------- */
    /* Reading annotations (highlight / underline / note)                */
    /* ---------------------------------------------------------------- */

    const ANNOTATION_COLOR_LABELS = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉', purple: '紫' };

    function annotationTextSegments(root) {
      const segments = [];
      let text = '';
      if (!root || typeof document === 'undefined') return { segments, text };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('code,pre,.katex,.ls-svg-figure,svg,style,script,.ls-annotation')) return NodeFilter.FILTER_REJECT;
          if (node.nodeValue === null || node.nodeValue === '') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node = walker.nextNode();
      while (node !== null) {
        segments.push({ node, start: text.length, end: text.length + node.nodeValue.length });
        text += node.nodeValue;
        node = walker.nextNode();
      }
      return { segments, text };
    }

    function unwrapAnnotationMarks(root) {
      if (!root) return;
      const marks = Array.from(root.querySelectorAll('.ls-annotation'));
      for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
      if (typeof root.normalize === 'function') root.normalize();
    }

    function decorateAnnotations(root, annotations) {
      if (!root) return;
      unwrapAnnotationMarks(root);
      const list = (Array.isArray(annotations) ? annotations : [])
        .filter((annotation) => annotation !== null && typeof annotation === 'object' && typeof annotation.quote === 'string' && annotation.quote !== '')
        .map((annotation) => {
          const current = annotationTextSegments(root);
          const occurrence = Number.isInteger(annotation.occurrence) ? Math.max(0, annotation.occurrence) : 0;
          let at = -1;
          for (let time = 0; time <= occurrence; time += 1) {
            at = current.text.indexOf(annotation.quote, at + 1);
            if (at < 0) return null;
          }
          return { annotation, start: at, end: at + annotation.quote.length };
        })
        .filter(Boolean)
        .sort((a, b) => b.start - a.start);
      for (const target of list) {
        const { segments } = annotationTextSegments(root);
        const wrappers = [];
        for (let index = segments.length - 1; index >= 0; index -= 1) {
          const segment = segments[index];
          if (segment.end <= target.start || segment.start >= target.end) continue;
          const localStart = Math.max(target.start, segment.start) - segment.start;
          const localEnd = Math.min(target.end, segment.end) - segment.start;
          const node = segment.node;
          if (localEnd <= localStart || node.parentNode === null) continue;
          const annotation = target.annotation;
          const wrapper = document.createElement(annotation.style === 'underline' ? 'u' : 'mark');
          wrapper.className = 'ls-annotation';
          wrapper.setAttribute('data-annotation-id', annotation.id);
          wrapper.setAttribute('data-color', annotation.color || 'yellow');
          wrapper.setAttribute('data-style', annotation.style === 'underline' ? 'underline' : 'highlight');
          if (typeof annotation.note === 'string' && annotation.note !== '') {
            wrapper.setAttribute('data-has-note', '');
            wrapper.setAttribute('title', annotation.note);
          }
          try {
            if (localStart === 0 && localEnd === node.nodeValue.length) {
              node.parentNode.replaceChild(wrapper, node);
              wrapper.appendChild(node);
            } else {
              const range = document.createRange();
              range.setStart(node, localStart);
              range.setEnd(node, localEnd);
              range.surroundContents(wrapper);
            }
            wrappers.push(wrapper);
          } catch (error) {
            /* skip un-wrappable ranges (e.g. partially inside an element) */
          }
        }
      }
    }

    function countOccurrencesBefore(text, quote) {
      if (typeof text !== 'string' || typeof quote !== 'string' || quote === '') return 0;
      let count = 0;
      let at = text.indexOf(quote);
      while (at >= 0) {
        count += 1;
        at = text.indexOf(quote, at + quote.length);
      }
      return count;
    }

    function NoteCompose({ selection, color, onSave, onCancel, busy }) {
      const [note, setNote] = React.useState('');
      return h(
        'div',
        {
          className: 'ls-ann-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        h(
          'div',
          { className: 'ls-ann-dialog' },
          h('h3', { className: 'ls-ann-dialog-title' }, '添加备注'),
          h('div', { className: 'ls-ann-quote' }, selection.length > 220 ? `${selection.slice(0, 220)}…` : selection),
          h('textarea', {
            className: 'ls-textarea ls-ann-note-input',
            rows: 5,
            autoFocus: true,
            placeholder: '写下你的理解、疑问或联想（会和这段文字一起保存）',
            value: note,
            onChange: (event) => setNote(event.target.value),
          }),
          h(
            'div',
            { className: 'ls-ann-dialog-actions' },
            h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onCancel, disabled: busy }, '取消'),
            h(
              'button',
              { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-primary', disabled: busy, onClick: () => onSave(note.trim()) },
              busy ? '保存中…' : '保存备注',
            ),
          ),
        ),
      );
    }

    function AnnotationPopover({ annotation, position, onSave, onDelete, onAppendNote, onDeleteNote, onClose }) {
      const notes = Array.isArray(annotation.notes)
        ? annotation.notes
        : typeof annotation.note === 'string' && annotation.note !== ''
          ? [{ id: 'legacy', text: annotation.note, createdAt: annotation.createdAt }]
          : [];
      const [draft, setDraft] = React.useState('');
      const [color, setColor] = React.useState(annotation.color || 'yellow');
      const [style, setStyle] = React.useState(annotation.style === 'underline' ? 'underline' : 'highlight');
      const [busy, setBusy] = React.useState(false);
      const [noteBusy, setNoteBusy] = React.useState(false);

      const save = async () => {
        setBusy(true);
        try {
          await onSave({ color, style });
        } finally {
          setBusy(false);
        }
      };

      const appendNote = async () => {
        const text = draft.trim();
        if (text === '') return;
        setNoteBusy(true);
        try {
          await onAppendNote(text);
          setDraft('');
        } finally {
          setNoteBusy(false);
        }
      };

      return h(
        'div',
        {
          className: 'ls-ann-popover',
          style: { left: `${position.left}px`, top: `${position.top}px` },
          onClick: (event) => event.stopPropagation(),
        },
        h(
          'div',
          { className: 'ls-ann-pop-head' },
          h('span', { className: 'ls-ann-pop-title' }, notes.length > 0 ? `标注 · ${notes.length} 条备注` : '标注'),
          h('button', { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onClose, 'aria-label': '关闭' }, '✕'),
        ),
        h('div', { className: 'ls-ann-pop-quote' }, annotation.quote.length > 160 ? `${annotation.quote.slice(0, 160)}…` : annotation.quote),
        h(
          'div',
          { className: 'ls-ann-pop-row' },
          h(
            'div',
            { className: 'ls-ann-swatches' },
            Object.keys(ANNOTATION_COLOR_LABELS).map((value) =>
              h('button', {
                key: value,
                type: 'button',
                className: 'ls-ann-swatch',
                'data-color': value,
                'data-active': color === value ? '' : undefined,
                title: ANNOTATION_COLOR_LABELS[value],
                onClick: () => setColor(value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ls-ann-style-toggle' },
            h(
              'button',
              { type: 'button', className: 'ls-ann-icon-btn', title: '高亮', 'aria-label': '高亮', 'data-active': style === 'highlight' ? '' : undefined, onClick: () => setStyle('highlight') },
              h(HighlightIcon, { size: 14 }),
            ),
            h(
              'button',
              { type: 'button', className: 'ls-ann-icon-btn', title: '下划线', 'aria-label': '下划线', 'data-active': style === 'underline' ? '' : undefined, onClick: () => setStyle('underline') },
              h(UnderlineIcon, { size: 14 }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ls-ann-notes' },
          notes.length === 0
            ? h('div', { className: 'ls-ann-notes-empty' }, '还没有备注，可以在下面追加。')
            : notes.map((note) =>
                h(
                  'div',
                  { key: note.id, className: 'ls-ann-note-item' },
                  h(
                    'div',
                    { className: 'ls-ann-note-main' },
                    h('div', { className: 'ls-ann-note-text' }, note.text),
                    h('div', { className: 'ls-ann-note-time' }, formatRelativeTime(note.updatedAt || note.createdAt)),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ls-ann-icon-btn ls-ann-icon-danger ls-ann-note-del',
                      title: '删除这条备注',
                      'aria-label': '删除这条备注',
                      disabled: noteBusy,
                      onClick: () => void onDeleteNote(note.id),
                    },
                    h(TrashIcon, { size: 13 }),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'ls-ann-note-add' },
          h('textarea', {
            className: 'ls-textarea ls-ann-pop-note',
            rows: 2,
            placeholder: '追加一条备注…（不会覆盖之前的备注）',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void appendNote();
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'ls-ann-icon-btn ls-ann-icon-primary',
              title: '追加备注',
              'aria-label': '追加备注',
              disabled: noteBusy || draft.trim() === '',
              onClick: () => void appendNote(),
            },
            noteBusy ? h(Spinner, null) : h('span', { className: 'ls-ann-plus', 'aria-hidden': true }, '+'),
          ),
        ),
        h(
          'div',
          { className: 'ls-ann-pop-actions' },
          h(
            'button',
            { type: 'button', className: 'ls-ann-icon-btn ls-ann-icon-danger', title: '删除标注', 'aria-label': '删除标注', disabled: busy || noteBusy, onClick: () => void onDelete() },
            h(TrashIcon, { size: 15 }),
          ),
          h(
            'button',
            { type: 'button', className: 'ls-ann-icon-btn ls-ann-icon-primary', title: '保存颜色/样式', 'aria-label': '保存颜色/样式', disabled: busy || noteBusy, onClick: () => void save() },
            busy ? h(Spinner, null) : h(CheckIcon, { size: 16 }),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Chapter reader                                                    */
    /* ---------------------------------------------------------------- */

    function ChapterReader({
      course,
      chapter,
      index,
      total,
      canPrev,
      canNext,
      isDone,
      quizResult,
      katexReady,
      prismReady,
      onBack,
      onPrev,
      onNext,
      onToggleDone,
      onRecordQuiz,
      onToast,
      onRefreshDetail,
    }) {
      const outline = Array.isArray(course.outline) ? course.outline : [];
      const outlineItem = outline[index] || {};
      const title = outlineItem.title || chapter.title || `第 ${index + 1} 章`;
      const rawConcepts = React.useMemo(() => {
        const fromChapter = normalizeReaderConcepts(chapter.concepts);
        if (fromChapter.length > 0) return fromChapter;
        const outlineConcepts = Array.isArray(outlineItem.concepts)
          ? outlineItem.concepts
              .filter((name) => typeof name === 'string' && name.trim() !== '')
              .map((name) => ({ name: name.trim() }))
          : [];
        return normalizeReaderConcepts(outlineConcepts);
      }, [chapter, outlineItem]);

      const conceptList = React.useMemo(
        () =>
          rawConcepts.map((concept) => ({
            ...concept,
            selfAssessment:
              course.progress !== null &&
              course.progress !== undefined &&
              course.progress.concepts !== null &&
              course.progress.concepts !== undefined &&
              course.progress.concepts[concept.name] !== undefined
                ? course.progress.concepts[concept.name].selfAssessment ?? null
                : null,
          })),
        [rawConcepts, course.progress],
      );
      const conceptNames = React.useMemo(() => conceptList.map((concept) => concept.name), [conceptList]);
      const selectionConceptNames = React.useMemo(() => {
        const names = [];
        const chapters = Array.isArray(course.chapters) ? course.chapters : [];
        const outlines = Array.isArray(course.outline) ? course.outline : [];
        const total = Math.max(chapters.length, outlines.length);
        for (let position = 0; position < total; position += 1) {
          const chapterConcepts = normalizeReaderConcepts(chapters[position] === null || chapters[position] === undefined ? null : chapters[position].concepts);
          const source =
            chapterConcepts.length > 0
              ? chapterConcepts
              : Array.isArray(outlines[position]?.concepts)
                ? outlines[position].concepts
                    .filter((name) => typeof name === 'string' && name.trim() !== '')
                    .map((name) => ({ name: name.trim() }))
                : [];
          for (const concept of source) {
            if (!names.includes(concept.name)) names.push(concept.name);
          }
        }
        return names.slice(0, 150);
      }, [course.chapters, course.outline]);
      const readerInnerRef = React.useRef(null);
      const [popup, setPopup] = React.useState(null);
      const [panel, setPanel] = React.useState(null);
      const [feedbackBusy, setFeedbackBusy] = React.useState(false);
      const [annotations, setAnnotations] = React.useState([]);
      const [annotationVersion, setAnnotationVersion] = React.useState(0);
      const [annotationPopup, setAnnotationPopup] = React.useState(null);
      const [noteCompose, setNoteCompose] = React.useState(null);
      const [annotationColor, setAnnotationColor] = React.useState('yellow');
      const [annotateBusy, setAnnotateBusy] = React.useState(false);

      const applyFeedback = React.useCallback(
        async (conceptName, assessment) => {
          if (typeof conceptName !== 'string' || conceptName.trim() === '') return;
          setFeedbackBusy(true);
          try {
            await callApi('feedback', { id: course.id, chapterIndex: index, conceptName, assessment });
            if (onToast) {
              onToast({
                kind: 'success',
                text:
                  assessment === 'lost'
                    ? `已标记「${conceptName}」为没懂，已下调该概念掌握度`
                    : assessment === 'unsure'
                      ? `已标记「${conceptName}」为有点模糊`
                      : `已标记「${conceptName}」为已理解`,
              });
            }
            if (onRefreshDetail) onRefreshDetail();
            setPopup(null);
          } catch (error) {
            if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '标记失败，请重试' });
          } finally {
            setFeedbackBusy(false);
          }
        },
        [course.id, index, onToast, onRefreshDetail],
      );

      React.useEffect(() => {
        let alive = true;
        setAnnotations([]);
        callApi('annotations', { id: course.id, chapterIndex: index })
          .then((result) => {
            if (!alive) return;
            setAnnotations(Array.isArray(result.items) ? result.items : []);
          })
          .catch(() => {
            /* annotations are optional */
          });
        return () => {
          alive = false;
        };
      }, [course.id, index]);

      React.useEffect(() => {
        const root = readerInnerRef.current === null ? null : readerInnerRef.current.querySelector('.ls-md');
        if (!root) return;
        decorateAnnotations(
          root,
          annotations.filter((annotation) => annotation !== null && typeof annotation === 'object' && annotation.chapterIndex === index),
        );
      }, [annotations, annotationVersion, chapter.markdown, index]);

      const selectedOccurrence = () => {
        const md = readerInnerRef.current === null ? null : readerInnerRef.current.querySelector('.ls-md');
        const selection = window.getSelection();
        const quote = popup === null ? '' : popup.text;
        if (!md || !selection || selection.rangeCount === 0 || quote === '') return 0;
        try {
          const range = selection.getRangeAt(0);
          const before = document.createRange();
          before.selectNodeContents(md);
          before.setEnd(range.startContainer, range.startOffset);
          return countOccurrencesBefore(before.toString(), quote);
        } catch (error) {
          return 0;
        }
      };

      const createAnnotation = async (style, note, occurrenceOverride) => {
        if (popup === null) return;
        setAnnotateBusy(true);
        try {
          const result = await callApi('annotate', {
            id: course.id,
            chapterIndex: index,
            quote: popup.text,
            occurrence: Number.isInteger(occurrenceOverride) ? occurrenceOverride : selectedOccurrence(),
            color: annotationColor,
            style,
            note: typeof note === 'string' ? note : '',
          });
          if (result.annotation !== null && result.annotation !== undefined) {
            setAnnotations((previous) => [result.annotation, ...previous]);
            setAnnotationVersion((value) => value + 1);
          }
          if (onToast) onToast({ kind: 'success', text: style === 'underline' ? '已添加下划线' : '已添加高亮' });
          setPopup(null);
          setNoteCompose(null);
        } catch (error) {
          if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '添加标注失败' });
        } finally {
          setAnnotateBusy(false);
        }
      };

      const saveAnnotation = async (annotation, patch) => {
        try {
          const result = await callApi('update-annotation', { id: course.id, annotationId: annotation.id, ...patch });
          if (result.annotation !== null && result.annotation !== undefined) {
            setAnnotations((previous) => previous.map((item) => (item.id === annotation.id ? result.annotation : item)));
            setAnnotationVersion((value) => value + 1);
            setAnnotationPopup((previous) => (previous === null ? null : { ...previous, annotation: result.annotation }));
          }
          if (onToast) onToast({ kind: 'success', text: '标注已保存' });
        } catch (error) {
          if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '保存标注失败' });
        }
      };

      const appendAnnotationNote = async (annotation, text) => {
        if (typeof text !== 'string' || text.trim() === '') return;
        try {
          const result = await callApi('update-annotation', {
            id: course.id,
            annotationId: annotation.id,
            appendNote: text.trim(),
          });
          if (result.annotation !== null && result.annotation !== undefined) {
            setAnnotations((previous) => previous.map((item) => (item.id === annotation.id ? result.annotation : item)));
            setAnnotationVersion((value) => value + 1);
            setAnnotationPopup((previous) => (previous === null ? null : { ...previous, annotation: result.annotation }));
          }
          if (onToast) onToast({ kind: 'success', text: '备注已追加' });
        } catch (error) {
          if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '追加备注失败' });
        }
      };

      const deleteAnnotationNote = async (annotation, noteId) => {
        try {
          const result = await callApi('update-annotation', {
            id: course.id,
            annotationId: annotation.id,
            deleteNoteId: noteId,
          });
          if (result.annotation !== null && result.annotation !== undefined) {
            setAnnotations((previous) => previous.map((item) => (item.id === annotation.id ? result.annotation : item)));
            setAnnotationVersion((value) => value + 1);
            setAnnotationPopup((previous) => (previous === null ? null : { ...previous, annotation: result.annotation }));
          }
          if (onToast) onToast({ kind: 'success', text: '备注已删除' });
        } catch (error) {
          if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '删除备注失败' });
        }
      };

      const deleteAnnotation = async (annotation) => {
        try {
          await callApi('delete-annotation', { id: course.id, annotationId: annotation.id });
          setAnnotations((previous) => previous.filter((item) => item.id !== annotation.id));
          setAnnotationVersion((value) => value + 1);
          setAnnotationPopup(null);
          if (onToast) onToast({ kind: 'success', text: '标注已删除' });
        } catch (error) {
          if (onToast) onToast({ kind: 'error', text: error && error.message ? error.message : '删除标注失败' });
        }
      };

      React.useEffect(() => {
        const readSelection = () => {
          const root = readerInnerRef.current;
          if (!root) return;
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            setPopup(null);
            return;
          }
          const range = selection.getRangeAt(0);
          const text = selection.toString().trim();
          if (text === '' || text.length > 3000) return;
          const node = range.commonAncestorContainer;
          const element = node && node.nodeType === 3 ? node.parentElement : node;
          if (!element || !root.contains(element)) {
            setPopup(null);
            return;
          }
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          const width = Math.min(860, window.innerWidth - 16);
          const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
          const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 240));
          const matched =
            selectionConceptNames
              .filter((name) => text.includes(name) || (text.length >= 2 && name.includes(text)))
              .sort((a, b) => b.length - a.length)[0] || '';
          setPopup({ text, left, top, concept: matched });
        };
        const clear = () => setPopup(null);
        document.addEventListener('mouseup', readSelection);
        document.addEventListener('keyup', readSelection);
        window.addEventListener('scroll', clear, true);
        window.addEventListener('resize', clear);
        return () => {
          document.removeEventListener('mouseup', readSelection);
          document.removeEventListener('keyup', readSelection);
          window.removeEventListener('scroll', clear, true);
          window.removeEventListener('resize', clear);
        };
      }, [selectionConceptNames]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') setPopup(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      const openPanel = (mode) => {
        if (!popup) return;
        setPanel({ mode, selection: popup.text, conceptName: popup.concept });
        setPopup(null);
      };

      const openConceptPanel = (conceptName) => {
        setPanel({ mode: 'explain', selection: '', conceptName });
      };

      return h(
        'div',
        { className: 'ls-panel' },
        h(
          'div',
          { className: 'ls-reader-bar' },
          h(
            'button',
            { type: 'button', className: 'ls-btn ls-btn-sm ls-btn-ghost', onClick: onBack },
            '← 返回课程',
          ),
          h(
            'div',
            { className: 'ls-reader-center' },
            h('span', { className: 'ls-reader-counter' }, `第 ${index + 1} / ${total} 章`),
            h(
              'div',
              { className: 'ls-reader-title-row' },
              h('span', { className: 'ls-reader-title', title }, title),
              isDone ? h('span', { className: 'ls-done-badge' }, '已完成') : null,
            ),
          ),
          h(
            'div',
            { className: 'ls-reader-nav' },
            quizResult !== null && quizResult !== undefined
              ? h(
                  Tag,
                  { tone: 'level' },
                  `上次测验 ${Number(quizResult.score) || 0} / ${Number(quizResult.total) || 0}`,
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm',
                onClick: onPrev,
                disabled: !canPrev,
                title: canPrev ? '上一章' : '上一章尚未生成',
              },
              '上一章',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-sm',
                onClick: onNext,
                disabled: !canNext,
                title: canNext ? '下一章' : '下一章尚未生成',
              },
              '下一章',
            ),
            h(
              'button',
              {
                type: 'button',
                className: isDone ? 'ls-btn ls-btn-sm ls-btn-ghost' : 'ls-btn ls-btn-sm ls-btn-primary',
                onClick: onToggleDone,
              },
              isDone ? '取消完成' : '标记完成',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ls-reader-scroll', key: index },
          h(
            'div',
            {
              className: 'ls-reader-inner',
              ref: readerInnerRef,
              onClick: (event) => {
                const target = event.target;
                if (!target || typeof target.closest !== 'function') return;
                const element = target.closest('.ls-annotation');
                if (!element) return;
                const annotationId = element.getAttribute('data-annotation-id');
                const annotation = annotations.find((item) => item.id === annotationId);
                if (!annotation) return;
                const rect = element.getBoundingClientRect();
                setAnnotationPopup({
                  annotation,
                  left: Math.max(8, Math.min(rect.left, window.innerWidth - 380)),
                  top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 330)),
                });
              },
            },
            h(MarkdownView, {
              markdown: chapter.markdown,
              katexReady: katexReady === true,
              prismReady: prismReady === true,
            }),
            h(ReaderConceptsSection, {
              key: `concepts-${index}`,
              concepts: conceptList,
              onExplainConcept: openConceptPanel,
              onFeedbackConcept: (name, assessment) => void applyFeedback(name, assessment),
            }),
            h(ReaderQuizSection, {
              key: `quiz-${index}`,
              quiz: chapter.quiz,
              lastResult: quizResult,
              onSubmit: (result) => onRecordQuiz(index, result),
            }),
          ),
        ),
        popup !== null
          ? h(
              'div',
              {
                className: 'ls-sel-toolbar',
                style: { left: `${popup.left}px`, top: `${popup.top}px` },
                onMouseDown: (event) => {
                  if (event.target !== null && event.target.tagName !== 'SELECT') event.preventDefault();
                },
              },
              selectionConceptNames.length > 0
                ? h(
                    'select',
                    {
                      className: 'ls-select ls-sel-concept',
                      value: popup.concept,
                      'aria-label': '选择概念',
                      onChange: (event) => setPopup((previous) => (previous === null ? previous : { ...previous, concept: event.target.value })),
                    },
                    h('option', { value: '' }, '不指定概念（自由讨论）'),
                    selectionConceptNames.map((name) => h('option', { key: name, value: name }, name)),
                  )
                : null,
              h(
                'span',
                { className: 'ls-ann-tools', role: 'group', 'aria-label': '标注工具' },
                h(
                  'span',
                  { className: 'ls-ann-colors', role: 'group', 'aria-label': '标注颜色' },
                  Object.keys(ANNOTATION_COLOR_LABELS).map((value) =>
                    h('button', {
                      key: value,
                      type: 'button',
                      className: 'ls-ann-dot',
                      'data-color': value,
                      'data-active': annotationColor === value ? '' : undefined,
                      'aria-label': `标注颜色：${ANNOTATION_COLOR_LABELS[value]}`,
                      title: ANNOTATION_COLOR_LABELS[value],
                      onClick: () => setAnnotationColor(value),
                    }),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-ann-icon-btn',
                    title: '高亮',
                    'aria-label': '高亮',
                    disabled: annotateBusy,
                    onClick: () => void createAnnotation('highlight', ''),
                  },
                  h(HighlightIcon, { size: 15 }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-ann-icon-btn',
                    title: '下划线',
                    'aria-label': '下划线',
                    disabled: annotateBusy,
                    onClick: () => void createAnnotation('underline', ''),
                  },
                  h(UnderlineIcon, { size: 15 }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-ann-icon-btn',
                    title: '添加备注',
                    'aria-label': '添加备注',
                    disabled: annotateBusy,
                    onClick: () => setNoteCompose({ selection: popup.text, occurrence: selectedOccurrence() }),
                  },
                  h(NoteIcon, { size: 15 }),
                ),
              ),
              h('span', { className: 'ls-sel-sep', 'aria-hidden': true }),
              h('button', { type: 'button', className: 'ls-sel-btn', onClick: () => openPanel('explain') }, '解释'),
              h('button', { type: 'button', className: 'ls-sel-btn', onClick: () => openPanel('compare') }, '辨析'),
              h('button', { type: 'button', className: 'ls-sel-btn', onClick: () => openPanel('figure') }, '画图'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-sel-btn ls-sel-btn-warn',
                  disabled: feedbackBusy,
                  onClick: () => {
                    if (popup.concept === '') {
                      if (onToast) onToast({ kind: 'warn', text: '请先在左侧选择这段内容对应的概念' });
                      return;
                    }
                    void applyFeedback(popup.concept, 'lost');
                  },
                },
                '我不懂',
              ),
            )
          : null,
        panel !== null
          ? h(InteractionPanel, {
              course,
              chapterIndex: index,
              mode: panel.mode,
              selection: panel.selection,
              conceptName: panel.conceptName,
              katexReady,
              prismReady,
              onClose: () => setPanel(null),
              onToast,
            })
          : null,
        annotationPopup !== null
          ? h(AnnotationPopover, {
              annotation: annotationPopup.annotation,
              position: { left: annotationPopup.left, top: annotationPopup.top },
              onSave: (patch) => saveAnnotation(annotationPopup.annotation, patch),
              onDelete: () => deleteAnnotation(annotationPopup.annotation),
              onAppendNote: (text) => appendAnnotationNote(annotationPopup.annotation, text),
              onDeleteNote: (noteId) => deleteAnnotationNote(annotationPopup.annotation, noteId),
              onClose: () => setAnnotationPopup(null),
            })
          : null,
        noteCompose !== null
          ? h(NoteCompose, {
              selection: noteCompose.selection,
              color: annotationColor,
              busy: annotateBusy,
              onSave: (note) => void createAnnotation('highlight', note, noteCompose.occurrence),
              onCancel: () => setNoteCompose(null),
            })
          : null,
      );
    }

    /* ---------------------------------------------------------------- */
    /* Course list card                                                  */
    /* ---------------------------------------------------------------- */

    function CourseCard({
      course,
      selected,
      progressEntry,
      confirming,
      deleting,
      onSelect,
      onRequestDelete,
      onCancelDelete,
      onConfirmDelete,
    }) {
      const stats = summaryStats(course);
      const entry = normalizeProgressEntry(progressEntry);
      const localDone = entry.done.filter((index) => index >= 0 && index < stats.total).length;
      const doneCount = Number.isFinite(Number(course.doneCount))
        ? clampCount(course.doneCount, stats.total)
        : localDone;
      const reviewDue = Number.isFinite(Number(course.reviewDue))
        ? Math.max(0, Math.round(Number(course.reviewDue)))
        : countReviewDue(entry, Date.now());
      const title = typeof course.title === 'string' && course.title !== '' ? course.title : '未命名课程';
      const deleted = deleting;
      const summaryTotal = Number.isFinite(Number(course.totalChapters))
        ? clampCount(course.totalChapters, stats.total)
        : stats.total;
      const summaryUnlocked = Number.isFinite(Number(course.unlockedCount))
        ? clampCount(course.unlockedCount, summaryTotal)
        : null;

      return h(
        'div',
        {
          className: 'ls-card',
          role: 'button',
          tabIndex: 0,
          'data-selected': selected ? '' : undefined,
          'aria-current': selected ? 'true' : undefined,
          onClick: onSelect,
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect();
            }
          },
        },
        h(
          'div',
          { className: 'ls-card-head' },
          h('div', { className: 'ls-card-title', title }, title),
          h(
            'div',
            { className: 'ls-card-delete-wrap' },
            confirming
              ? h(
                  'div',
                  { className: 'ls-confirm' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ls-btn ls-btn-sm ls-btn-danger',
                      disabled: deleted,
                      onClick: (event) => {
                        event.stopPropagation();
                        onConfirmDelete();
                      },
                    },
                    deleted ? '删除中…' : '确认删除',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ls-btn ls-btn-sm ls-btn-ghost',
                      disabled: deleted,
                      onClick: (event) => {
                        event.stopPropagation();
                        onCancelDelete();
                      },
                    },
                    '取消',
                  ),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-card-delete',
                    title: '删除课程',
                    'aria-label': `删除课程 ${title}`,
                    onClick: (event) => {
                      event.stopPropagation();
                      onRequestDelete();
                    },
                  },
                  h(TrashIcon, null),
                ),
          ),
        ),
        h(
          'div',
          { className: 'ls-tags' },
          h(Tag, { tone: 'domain' }, DOMAIN_LABELS[course.domain] || DOMAIN_LABELS.general),
          h(Tag, { tone: 'level' }, LEVEL_LABELS[course.level] || LEVEL_LABELS.beginner),
          reviewDue > 0 ? h(Tag, { tone: 'warn' }, `待复习 ${reviewDue}`) : null,
          summaryUnlocked !== null && summaryTotal > 0
            ? h(Tag, { tone: 'idle' }, `解锁 ${summaryUnlocked} / ${summaryTotal}`)
            : null,
          stats.total > 0 && stats.generated >= stats.total ? h(Tag, { tone: 'success' }, '已全部生成') : null,
        ),
        h(
          'div',
          { className: 'ls-card-meta' },
          h('span', null, `已生成 ${stats.generated} / ${stats.total} 章`),
          h('span', null, formatRelativeTime(course.updatedAt)),
        ),
        h(ProgressBar, { value: doneCount, total: stats.total, tone: 'success' }),
        h('div', { className: 'ls-card-foot' }, `学习进度 ${doneCount} / ${stats.total} 章`),
      );
    }

    /**
     * Track a vendored script's readiness: one synchronous probe, ready/failed
     * events, and bounded polling. Mirrors the KaTeX loading pattern.
     */
    function useAssetReady(readyEvent, failedEvent, check) {
      const checkRef = React.useRef(check);
      checkRef.current = check;
      const [ready, setReady] = React.useState(() => {
        try {
          return Boolean(checkRef.current());
        } catch (error) {
          return false;
        }
      });

      React.useEffect(() => {
        if (ready) return undefined;
        let cancelled = false;
        let timer = 0;
        const probe = () => {
          if (cancelled) return;
          let value = false;
          try {
            value = Boolean(checkRef.current());
          } catch (error) {
            value = false;
          }
          if (value) setReady(true);
        };
        const onReady = () => probe();
        const onFailed = () => {
          if (timer !== 0) window.clearInterval(timer);
          timer = 0;
        };
        probe();
        window.addEventListener(readyEvent, onReady);
        window.addEventListener(failedEvent, onFailed);
        timer = window.setInterval(probe, 500);
        const giveUpTimer = window.setTimeout(() => {
          if (timer !== 0) window.clearInterval(timer);
          timer = 0;
        }, 60 * 1000);
        return () => {
          cancelled = true;
          window.removeEventListener(readyEvent, onReady);
          window.removeEventListener(failedEvent, onFailed);
          if (timer !== 0) window.clearInterval(timer);
          window.clearTimeout(giveUpTimer);
        };
      }, [ready, readyEvent, failedEvent]);

      return ready;
    }

    /* ---------------------------------------------------------------- */
    /* Page                                                              */
    /* ---------------------------------------------------------------- */

    function LearningSpacePage() {
      const [bootPhase, setBootPhase] = React.useState('loading');
      const [bootError, setBootError] = React.useState('');
      const [dataDir, setDataDir] = React.useState('');
      const [courses, setCourses] = React.useState([]);
      const [search, setSearch] = React.useState('');
      const [selectedId, setSelectedId] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailPhase, setDetailPhase] = React.useState('idle');
      const [detailError, setDetailError] = React.useState('');
      const [composeOpen, setComposeOpen] = React.useState(false);
      const [readerIndex, setReaderIndex] = React.useState(null);
      const [activeChapter, setActiveChapter] = React.useState(null);
      const [detailTab, setDetailTab] = React.useState('chapters');
      const [reviewIndex, setReviewIndex] = React.useState(null);
      const [graphBusy, setGraphBusy] = React.useState(false);
      const [progress, setProgress] = React.useState(() => loadProgress());
      const [notice, setNotice] = React.useState(null);
      const [generation, setGeneration] = React.useState(null);
      const [deleteId, setDeleteId] = React.useState(null);
      const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
      const [deletingId, setDeletingId] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);
      const katexReady = useAssetReady(
        KATEX_READY_EVENT,
        KATEX_FAILED_EVENT,
        () => typeof window !== 'undefined' && Boolean(window.katex && window.katex.renderToString),
      );
      const prismReady = useAssetReady(
        PRISM_READY_EVENT,
        PRISM_FAILED_EVENT,
        () => typeof window !== 'undefined' && Boolean(window.Prism && window.Prism.highlight),
      );
      const [, setTick] = React.useState(0);

      const mountedRef = React.useRef(true);
      const detailRef = React.useRef(null);
      const progressRef = React.useRef(progress);
      const selectedIdRef = React.useRef(null);
      const detailRequestRef = React.useRef(0);
      const loadDetailRef = React.useRef(null);
      const generationRef = React.useRef({ running: false, cancel: false, jobId: null, controller: null, runId: 0 });
      const graphRequestRef = React.useRef(0);
      const progressSyncRef = React.useRef({
        timers: new Map(),
        pending: new Map(),
        inflight: new Set(),
        versions: new Map(),
        failures: new Map(),
      });
      const flushProgressSyncRef = React.useRef(null);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          generationRef.current.cancel = true;
          generationRef.current.running = false;
          generationRef.current.jobId = null;
          if (generationRef.current.controller !== null) {
            try {
              generationRef.current.controller.abort();
            } catch (error) {
              /* already aborted */
            }
            generationRef.current.controller = null;
          }
          const sync = progressSyncRef.current;
          for (const timer of sync.timers.values()) window.clearTimeout(timer);
          sync.timers.clear();
        };
      }, []);

      React.useEffect(() => {
        detailRef.current = detail;
      }, [detail]);

      React.useEffect(() => {
        progressRef.current = progress;
      }, [progress]);

      React.useEffect(() => {
        selectedIdRef.current = selectedId;
      }, [selectedId]);

      React.useEffect(() => {
        if (selectedId === null) setSidebarCollapsed(false);
      }, [selectedId]);

      // Keep relative timestamps fresh while the page stays mounted.
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (mountedRef.current) setTick((value) => value + 1);
        }, 60 * 1000);
        return () => window.clearInterval(timer);
      }, []);

      // Auto-dismiss lightweight notices; errors and sync warnings stay closable.
      React.useEffect(() => {
        if (notice === null || notice.kind === 'error' || notice.kind === 'warn') return undefined;
        const timer = window.setTimeout(() => {
          if (mountedRef.current) setNotice(null);
        }, 4500);
        return () => window.clearTimeout(timer);
      }, [notice]);

      // In-app + system reminders for scheduled study-plan tasks.
      React.useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const REMIND_KEY = 'dsh.learning-space.plan-reminded.v1';
        const check = () => {
          const current = detailRef.current;
          if (!current) return;
          const now = Date.now();
          const due = (Array.isArray(current.studyPlan) ? current.studyPlan : []).filter(
            (item) => item !== null && item !== undefined && item.status === 'pending' && Number(item.dueAt) > 0 && Number(item.dueAt) <= now,
          );
          if (due.length === 0) return;
          let reminded = {};
          try {
            reminded = readStorageJson(REMIND_KEY, {}) || {};
          } catch (error) {
            reminded = {};
          }
          const fresh = due.filter((item) => reminded[item.id] !== true);
          if (fresh.length === 0) return;
          for (const item of fresh) reminded[item.id] = true;
          writeStorageJson(REMIND_KEY, reminded);
          const first = fresh[0];
          if (mountedRef.current) {
            setNotice({
              kind: 'warn',
              text: `计划提醒：${first.title} 已到期${fresh.length > 1 ? `（共 ${fresh.length} 个到期任务）` : ''}`,
            });
          }
          try {
            if (typeof window.Notification === 'function' && window.Notification.permission === 'granted') {
              new window.Notification('学习空间计划提醒', { body: first.title });
            }
          } catch (error) {
            /* system notifications are optional */
          }
        };
        check();
        const timer = window.setInterval(check, 30 * 1000);
        return () => window.clearInterval(timer);
      }, [selectedId, detail]);

      /** Update the local mirror (state + localStorage) and, when mounted, the list/detail mirrors. */
      const applyProgressEntry = React.useCallback((courseId, entry) => {
        const normalized = normalizeProgressEntry(entry);
        const next = { ...progressRef.current, [courseId]: normalized };
        progressRef.current = next;
        writeStorageJson(PROGRESS_KEY, next);
        if (!mountedRef.current) return normalized;
        setProgress(next);
        setCourses((previous) =>
          previous.map((course) =>
            course.id === courseId
              ? {
                  ...course,
                  doneCount: normalized.done.length,
                  quizCount: Object.keys(normalized.quiz).length,
                  reviewDue: countReviewDue(normalized, Date.now()),
                }
              : course,
          ),
        );
        if (detailRef.current !== null && detailRef.current.id === courseId) {
          detailRef.current = { ...detailRef.current, progress: normalized };
        }
        setDetail((previous) =>
          previous !== null && previous.id === courseId ? { ...previous, progress: normalized } : previous,
        );
        return normalized;
      }, []);

      /** Apply Host-authoritative curriculum/mastery after a progress write. */
      const applyLearningState = React.useCallback((courseId, result) => {
        if (result === null || result === undefined) return null;
        const rawCurriculum = result.curriculum;
        const rawMastery = result.mastery;
        if (rawCurriculum === undefined && rawMastery === undefined) return null;
        const current = detailRef.current;
        const currentMatch = current !== null && current.id === courseId;
        const total = currentMatch ? courseTotalChapters(current) : Math.max(0, Number(rawCurriculum && rawCurriculum.total) || 0);
        const curriculum = rawCurriculum !== undefined ? normalizeCurriculum(rawCurriculum, total) : currentMatch ? curriculumOf(current) : null;
        const mastery = normalizeMastery(rawMastery);
        if (curriculum === null && mastery === null) return null;
        if (currentMatch) {
          const chapters =
            curriculum !== null && Array.isArray(current.chapters)
              ? current.chapters.map((chapter, index) =>
                  chapter === null || chapter === undefined
                    ? chapter
                    : { ...chapter, unlocked: curriculum.unlocked.includes(index) },
                )
              : current.chapters;
          const nextDetail = {
            ...current,
            ...(curriculum !== null ? { curriculum } : null),
            ...(mastery !== null ? { mastery } : null),
            chapters,
          };
          detailRef.current = nextDetail;
          setDetail(nextDetail);
        }
        if (mountedRef.current) {
          setCourses((previous) =>
            previous.map((course) =>
              course.id === courseId
                ? {
                    ...course,
                    ...(curriculum !== null
                      ? { unlockedCount: curriculum.unlocked.length, totalChapters: curriculum.total }
                      : null),
                    ...(mastery !== null ? { mastery: mastery.overall } : null),
                  }
                : course,
            ),
          );
        }
        return { curriculum, mastery };
      }, []);

      /** Write the latest local progress back to course.json; failures retry later. */
      const flushProgressSync = React.useCallback(
        async (courseId) => {
          const sync = progressSyncRef.current;
          if (sync.inflight.has(courseId)) return;
          const entry = sync.pending.get(courseId);
          if (entry === undefined) return;
          sync.pending.delete(courseId);
          sync.inflight.add(courseId);
          const version = sync.versions.get(courseId) || 0;
          try {
            const result = await callApi('progress', { id: courseId, progress: entry });
            if (!mountedRef.current) return;
            const serverProgress = normalizeProgressEntry(result.progress);
            if ((sync.versions.get(courseId) || 0) === version) {
              sync.failures.delete(courseId);
              applyProgressEntry(courseId, serverProgress);
              setNotice((previous) => (previous !== null && previous.tag === 'progress' ? null : previous));
              const learning = applyLearningState(courseId, result);
              const newlyUnlocked = Array.isArray(result.newlyUnlocked)
                ? result.newlyUnlocked.map(Number).filter((index) => Number.isInteger(index) && index >= 0)
                : [];
              if (newlyUnlocked.length > 0) {
                const current = detailRef.current;
                const text = unlockNoticeText(
                  learning !== null ? learning.curriculum : null,
                  newlyUnlocked,
                  current !== null && current.id === courseId ? current : null,
                );
                if (text !== '') setNotice({ kind: 'success', text });
                if (selectedIdRef.current === courseId && loadDetailRef.current !== null) {
                  void loadDetailRef.current(courseId, { silent: true });
                }
                void callApi('state')
                  .then((stateResult) => {
                    if (!mountedRef.current) return;
                    const list = Array.isArray(stateResult.courses) ? stateResult.courses : [];
                    setCourses(list);
                    if (typeof stateResult.dataDir === 'string') setDataDir(stateResult.dataDir);
                  })
                  .catch(() => {
                    /* list refresh is best-effort; local curriculum state is already updated */
                  });
              }
            } else if (!sync.pending.has(courseId)) {
              const newer = progressRef.current[courseId];
              if (newer !== undefined) sync.pending.set(courseId, newer);
            }
          } catch (error) {
            if (!mountedRef.current) return;
            if (!sync.pending.has(courseId)) sync.pending.set(courseId, entry);
            sync.failures.set(courseId, (sync.failures.get(courseId) || 0) + 1);
            setNotice({
              kind: 'warn',
              tag: 'progress',
              text: '进度已保存在本地，稍后会自动重试同步。',
            });
          } finally {
            sync.inflight.delete(courseId);
            if (mountedRef.current && sync.pending.has(courseId)) {
              const existing = sync.timers.get(courseId);
              if (existing !== undefined) window.clearTimeout(existing);
              const failures = sync.failures.get(courseId) || 0;
              const retryDelay = Math.min(
                PROGRESS_SYNC_RETRY_MS * 2 ** Math.max(0, failures - 1),
                15000,
              );
              sync.timers.set(
                courseId,
                window.setTimeout(() => {
                  sync.timers.delete(courseId);
                  if (flushProgressSyncRef.current !== null) void flushProgressSyncRef.current(courseId);
                }, retryDelay),
              );
            }
          }
        },
        [applyProgressEntry, applyLearningState],
      );
      flushProgressSyncRef.current = flushProgressSync;

      /** Debounced enqueue of a progress write for one course. */
      const scheduleProgressSync = React.useCallback((courseId, entry, immediate) => {
        const sync = progressSyncRef.current;
        sync.pending.set(courseId, normalizeProgressEntry(entry));
        sync.versions.set(courseId, (sync.versions.get(courseId) || 0) + 1);
        const existing = sync.timers.get(courseId);
        if (existing !== undefined) window.clearTimeout(existing);
        sync.timers.set(
          courseId,
          window.setTimeout(() => {
            sync.timers.delete(courseId);
            if (flushProgressSyncRef.current !== null) void flushProgressSyncRef.current(courseId);
          }, immediate === true ? 0 : PROGRESS_SYNC_DELAY_MS),
        );
      }, []);

      const retryPendingProgress = React.useCallback(() => {
        for (const courseId of [...progressSyncRef.current.pending.keys()]) {
          if (flushProgressSyncRef.current !== null) void flushProgressSyncRef.current(courseId);
        }
      }, []);

      /** Adopt course.progress as authoritative; migrate/recover localStorage when it is newer. */
      const adoptCourseProgress = React.useCallback(
        (course) => {
          const server = normalizeProgressEntry(course.progress);
          const local = normalizeProgressEntry(progressRef.current[course.id]);
          let entry = server;
          let needsSync = false;
          if (isProgressEmpty(server) && !isProgressEmpty(local)) {
            entry = mergeProgressEntries(server, local);
            needsSync = true;
          } else if (local.updatedAt > server.updatedAt && !sameProgress(local, server)) {
            entry = local;
            needsSync = true;
          }
          applyProgressEntry(course.id, entry);
          if (needsSync) scheduleProgressSync(course.id, entry, true);
          return entry;
        },
        [applyProgressEntry, scheduleProgressSync],
      );

      const commitProgress = React.useCallback(
        (courseId, mutate) => {
          const previous = progressRef.current;
          const entry = normalizeProgressEntry(previous[courseId]);
          const draft = {
            done: entry.done.slice(),
            quiz: { ...entry.quiz },
            review: { ...entry.review },
            concepts: { ...entry.concepts },
            updatedAt: 0,
          };
          mutate(draft);
          draft.updatedAt = Date.now();
          const normalized = applyProgressEntry(courseId, draft);
          scheduleProgressSync(courseId, normalized);
          return normalized;
        },
        [applyProgressEntry, scheduleProgressSync],
      );

      const toggleDone = React.useCallback(
        (courseId, index) => {
          commitProgress(courseId, (draft) => {
            const set = new Set(draft.done);
            if (set.has(index)) set.delete(index);
            else set.add(index);
            draft.done = [...set].sort((a, b) => a - b);
          });
        },
        [commitProgress],
      );

      /** Quiz submission also schedules spaced repetition (both first quiz and review). */
      const recordQuiz = React.useCallback(
        (courseId, index, result) => {
          const now = Date.now();
          let reviewEntry = null;
          commitProgress(courseId, (draft) => {
            const quizAt = Number.isFinite(result.at) ? result.at : now;
            draft.quiz[String(index)] = {
              score: result.score,
              total: result.total,
              answers: result.answers,
              at: quizAt,
            };
            reviewEntry = nextReviewEntry(draft.review[String(index)], result.score, result.total, now);
            draft.review[String(index)] = reviewEntry;
          });
          return reviewEntry;
        },
        [commitProgress],
      );

      const loadDetail = React.useCallback(async (courseId, options) => {
        const silent = Boolean(options && options.silent);
        const requestId = detailRequestRef.current + 1;
        detailRequestRef.current = requestId;
        if (!silent && mountedRef.current) {
          setDetailPhase('loading');
          setDetailError('');
        }
        try {
          const result = await callApi('course', { id: courseId });
          if (!mountedRef.current || requestId !== detailRequestRef.current) return null;
          if (selectedIdRef.current !== courseId) return null;
          const course = result.course !== null && result.course !== undefined ? result.course : null;
          if (course === null) throw new Error('课程不存在或已被删除');
          const entry = adoptCourseProgress(course);
          const nextCourse = { ...course, progress: entry };
          detailRef.current = nextCourse;
          setDetail(nextCourse);
          setDetailPhase('ready');
          return nextCourse;
        } catch (error) {
          if (!mountedRef.current || requestId !== detailRequestRef.current) return null;
          if (!silent) {
            setDetailPhase('error');
            setDetailError(error && error.message ? error.message : '加载课程失败');
          }
          return null;
        }
      }, [adoptCourseProgress]);
      loadDetailRef.current = loadDetail;

      // Retry failed progress syncs when the window regains focus.
      React.useEffect(() => {
        const onFocus = () => retryPendingProgress();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
      }, [retryPendingProgress]);

      const selectCourse = React.useCallback((courseId) => {
        setComposeOpen(false);
        setDeleteId(null);
        setSidebarCollapsed(true);
        if (courseId === selectedIdRef.current) {
          // Clicking the selected card again returns to the chapters view.
          setReaderIndex(null);
          setReviewIndex(null);
          setDetailTab('chapters');
          return;
        }
        selectedIdRef.current = courseId;
        setSelectedId(courseId);
        writeLastCourseId(courseId);
      }, []);

      const loadState = React.useCallback(async () => {
        const result = await callApi('state');
        if (!mountedRef.current) return null;
        const now = Date.now();
        const list = (Array.isArray(result.courses) ? result.courses : []).map((course) => {
          const local = progressRef.current[course.id];
          if (
            local !== undefined &&
            local.updatedAt > (Number.isFinite(course.progressUpdatedAt) ? course.progressUpdatedAt : 0)
          ) {
            return {
              ...course,
              doneCount: local.done.length,
              quizCount: Object.keys(local.quiz).length,
              reviewDue: countReviewDue(local, now),
            };
          }
          return course;
        });
        setCourses(list);
        setDataDir(typeof result.dataDir === 'string' ? result.dataDir : '');
        setBootPhase('ready');
        setBootError('');
        return list;
      }, []);

      const bootstrap = React.useCallback(async () => {
        setBootPhase('loading');
        setBootError('');
        try {
          const list = await loadState();
          if (list === null || !mountedRef.current) return;
          const last = readLastCourseId();
          if (last !== null && list.some((course) => course.id === last)) {
            selectedIdRef.current = last;
            setSelectedId(last);
          }
        } catch (error) {
          if (!mountedRef.current) return;
          setBootError(error && error.message ? error.message : '加载课程列表失败');
          setBootPhase('error');
        }
      }, [loadState]);

      React.useEffect(() => {
        void bootstrap();
        return () => {
          mountedRef.current = false;
          generationRef.current.cancel = true;
          generationRef.current.running = false;
        };
      }, [bootstrap]);

      // Load the selected course; silent when it is already displayed.
      React.useEffect(() => {
        if (selectedId === null) {
          detailRequestRef.current += 1;
          detailRef.current = null;
          setDetail(null);
          setDetailPhase('idle');
          setDetailError('');
          return;
        }
        const silent = detailRef.current !== null && detailRef.current.id === selectedId;
        setReaderIndex(null);
        setActiveChapter(null);
        setDetailTab('chapters');
        setReviewIndex(null);
        setGraphBusy(false);
        void loadDetail(selectedId, { silent });
      }, [selectedId, loadDetail]);

      const refreshAll = React.useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
          const list = await loadState();
          if (!mountedRef.current || list === null) return;
          const current = selectedIdRef.current;
          if (current !== null && !list.some((course) => course.id === current)) {
            selectedIdRef.current = null;
            setSelectedId(null);
            setReaderIndex(null);
            setActiveChapter(null);
            writeLastCourseId(null);
          } else if (current !== null) {
            await loadDetail(current, { silent: true });
          }
          if (mountedRef.current) setNotice({ kind: 'success', text: '已刷新课程列表。' });
        } catch (error) {
          if (mountedRef.current) {
            setNotice({ kind: 'error', text: error && error.message ? error.message : '刷新失败，请重试' });
          }
        } finally {
          if (mountedRef.current) setRefreshing(false);
        }
      }, [refreshing, loadState, loadDetail]);

      const refreshSelectedCourse = React.useCallback(async () => {
        const current = selectedIdRef.current;
        try {
          await loadState();
        } catch (error) {
          /* list refresh is best-effort */
        }
        if (current !== null) await loadDetail(current, { silent: true });
      }, [loadState, loadDetail]);

      const handleOutlineCreated = React.useCallback((course) => {
        const total = Array.isArray(course.outline) ? course.outline.length : Number(course.chapterCount) || 0;
        const summary = {
          id: course.id,
          title: course.title,
          topic: course.topic,
          domain: course.domain,
          level: course.level,
          chapterCount: course.chapterCount,
          generatedCount: 0,
          doneCount: 0,
          quizCount: 0,
          reviewDue: 0,
          hasGraph: false,
          unlockedCount: unlockedCountOf(course),
          totalChapters: total,
          mastery: (() => {
            const mastery = masteryOf(course);
            return mastery !== null ? mastery.overall : 0;
          })(),
          status: course.status !== undefined ? course.status : 'planned',
          createdAt: Number.isFinite(course.createdAt) ? course.createdAt : Date.now(),
          updatedAt: Number.isFinite(course.updatedAt) ? course.updatedAt : Date.now(),
          progressUpdatedAt: Number.isFinite(course.progressUpdatedAt) ? course.progressUpdatedAt : 0,
        };
        const entry = normalizeProgressEntry(course.progress);
        const nextProgress = { ...progressRef.current, [course.id]: entry };
        progressRef.current = nextProgress;
        writeStorageJson(PROGRESS_KEY, nextProgress);
        setProgress(nextProgress);
        const nextCourse = { ...course, progress: entry };
        detailRef.current = nextCourse;
        selectedIdRef.current = course.id;
        setDetail(nextCourse);
        setDetailPhase('ready');
        setDetailError('');
        setCourses((previous) => [summary, ...previous.filter((item) => item.id !== course.id)]);
        setComposeOpen(false);
        setSelectedId(course.id);
        setReaderIndex(null);
        setActiveChapter(null);
        setDetailTab('chapters');
        setReviewIndex(null);
        writeLastCourseId(course.id);
        setNotice({ kind: 'success', text: `已生成《${course.title}》的大纲，共 ${total} 章。` });
      }, []);

      const requestDelete = React.useCallback((courseId) => {
        setDeleteId(courseId);
      }, []);

      const cancelDelete = React.useCallback(() => {
        setDeleteId(null);
      }, []);

      const confirmDelete = React.useCallback(
        async (courseId) => {
          if (deletingId !== null) return;
          const activeGeneration = generationRef.current.running;
          if (activeGeneration && generation !== null && generation.courseId === courseId) {
            setDeleteId(null);
            setNotice({ kind: 'error', text: '该课程正在生成章节，请先取消生成再删除。' });
            return;
          }
          setDeletingId(courseId);
          try {
            await callApi('delete', { id: courseId });
            if (!mountedRef.current) return;
            setDeleteId(null);
            const removed = courses.find((course) => course.id === courseId);
            setCourses((previous) => previous.filter((course) => course.id !== courseId));
            const previousProgress = progressRef.current;
            if (Object.prototype.hasOwnProperty.call(previousProgress, courseId)) {
              const nextProgress = { ...previousProgress };
              delete nextProgress[courseId];
              progressRef.current = nextProgress;
              writeStorageJson(PROGRESS_KEY, nextProgress);
              setProgress(nextProgress);
            }
            const sync = progressSyncRef.current;
            const pendingTimer = sync.timers.get(courseId);
            if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
            sync.timers.delete(courseId);
            sync.pending.delete(courseId);
            sync.versions.delete(courseId);
            if (selectedIdRef.current === courseId) {
              selectedIdRef.current = null;
              setSelectedId(null);
              setReaderIndex(null);
              setActiveChapter(null);
              setReviewIndex(null);
              setDetailTab('chapters');
              detailRef.current = null;
              setDetail(null);
              writeLastCourseId(null);
            }
            setNotice({ kind: 'success', text: `已删除课程「${removed ? removed.title : courseId}」。` });
            void loadState().catch(() => {
              /* local list already matches; refresh is best-effort */
            });
          } catch (error) {
            if (mountedRef.current) {
              setNotice({ kind: 'error', text: `删除失败：${error && error.message ? error.message : '未知错误'}` });
            }
          } finally {
            if (mountedRef.current) setDeletingId(null);
          }
        },
        [courses, deletingId, generation, loadState],
      );

      /**
       * Serially generate chapter indexes through the Host job pipeline:
       * start -> poll -> merge; failures stop the run and keep retry/continue.
       */
      const runGeneration = React.useCallback(
        async (courseId, indexes, titleHint) => {
          const engine = generationRef.current;
          if (engine.running) return;
          const queue = Array.isArray(indexes)
            ? indexes.filter((index) => Number.isInteger(index) && index >= 0)
            : [];
          if (queue.length === 0) return;

          engine.running = true;
          engine.cancel = false;
          engine.jobId = null;
          engine.controller = null;
          engine.runId += 1;
          const runId = engine.runId;
          const course = detailRef.current !== null && detailRef.current.id === courseId ? detailRef.current : null;
          const courseTitle =
            course !== null && typeof course.title === 'string'
              ? course.title
              : typeof titleHint === 'string' && titleHint !== ''
                ? titleHint
                : '课程';

          if (mountedRef.current) {
            setGeneration({
              courseId,
              courseTitle,
              indices: queue.slice(),
              total: queue.length,
              done: 0,
              currentIndex: queue[0],
              currentTitle: outlineTitle(course, queue[0]),
              running: true,
              cancelRequested: false,
              failedStep: null,
              failedIndex: null,
              error: '',
              job: null,
            });
          }

          let completed = 0;
          const runWarnings = new Set();
          const collectWarnings = (job) => {
            if (job === null || job === undefined || !Array.isArray(job.warnings)) return;
            for (const warning of job.warnings) runWarnings.add(warning);
          };
          try {
            for (let step = 0; step < queue.length; step += 1) {
              if (engine.cancel || !mountedRef.current || engine.runId !== runId) break;
              const index = queue[step];
              const currentCourse =
                detailRef.current !== null && detailRef.current.id === courseId ? detailRef.current : course;
              if (mountedRef.current) {
                setGeneration((previous) =>
                  previous === null
                    ? previous
                    : {
                        ...previous,
                        currentIndex: index,
                        currentTitle: outlineTitle(currentCourse, index),
                        done: step,
                        job: null,
                      },
                );
              }

              const controller = typeof AbortController === 'function' ? new AbortController() : null;
              engine.controller = controller;
              const signal = controller !== null ? controller.signal : undefined;
              let chapter = null;
              try {
                const started = await startChapterJob(courseId, index, false, signal);
                if (!mountedRef.current || engine.runId !== runId) return;
                if (engine.cancel) {
                  if (started.job !== null) {
                    void cancelChapterJob(started.job.id).catch(() => {
                      /* job may already be gone */
                    });
                  }
                  engine.cancel = false;
                  engine.jobId = null;
                  setGeneration(null);
                  setNotice({ kind: 'info', text: '已取消生成；已完成的章节会保留。' });
                  return;
                }

                if (started.chapter !== null) {
                  chapter = started.chapter;
                } else {
                  engine.jobId = started.job.id;
                  collectWarnings(started.job);
                  if (mountedRef.current) {
                    setGeneration((previous) =>
                      previous === null
                        ? previous
                        : { ...previous, job: started.job, reused: started.reused === true },
                    );
                  }
                  chapter = await pollChapterJob(started.job.id, {
                    signal,
                    onUpdate: (job) => {
                      if (!mountedRef.current || engine.runId !== runId) return;
                      collectWarnings(job);
                      setGeneration((previous) => (previous === null ? previous : { ...previous, job }));
                    },
                  });
                }
              } catch (failure) {
                if (!mountedRef.current || engine.runId !== runId) return;
                if (failure !== null && failure !== undefined && failure.code === 'LOCKED') {
                  engine.cancel = false;
                  engine.jobId = null;
                  setGeneration(null);
                  setNotice({
                    kind: 'error',
                    text: failure.message ? failure.message : `第 ${index + 1} 章尚未解锁，请先完成上一章学习。`,
                  });
                  if (loadDetailRef.current !== null) void loadDetailRef.current(courseId, { silent: true });
                  return;
                }
                const cancelled =
                  engine.cancel ||
                  (failure !== null && failure !== undefined && failure.cancelled === true) ||
                  (failure !== null && failure !== undefined && failure.name === 'AbortError');
                if (cancelled) {
                  engine.cancel = false;
                  engine.jobId = null;
                  setGeneration(null);
                  setNotice({ kind: 'info', text: '已取消生成；已完成的章节会保留。' });
                  return;
                }
                const message =
                  failure !== null && failure !== undefined && typeof failure.message === 'string' && failure.message !== ''
                    ? failure.message
                    : '生成失败，请重试';
                const failureJob =
                  failure !== null && failure !== undefined && failure.job !== null && failure.job !== undefined
                    ? failure.job
                    : null;
                setGeneration((previous) =>
                  previous === null
                    ? previous
                    : {
                        ...previous,
                        running: false,
                        failedStep: step,
                        failedIndex: index,
                        error: message,
                        job: failureJob !== null ? failureJob : previous.job,
                      },
                );
                return;
              } finally {
                engine.jobId = null;
                if (engine.controller === controller) engine.controller = null;
              }

              if (!mountedRef.current || engine.runId !== runId) return;
              if (engine.cancel) {
                engine.cancel = false;
                setGeneration(null);
                setNotice({ kind: 'info', text: '已取消生成；已完成的章节会保留。' });
                return;
              }
              if (chapter === null || chapter === undefined || typeof chapter !== 'object') {
                setGeneration((previous) =>
                  previous === null
                    ? previous
                    : { ...previous, running: false, failedStep: step, failedIndex: index, error: '生成失败，请重试' },
                );
                return;
              }

              const base =
                detailRef.current !== null && detailRef.current.id === courseId ? detailRef.current : currentCourse;
              if (chapter !== null && chapter !== undefined && base !== null) {
                const merged = withChapter(base, chapter);
                if (merged !== base) {
                  detailRef.current = merged;
                  setDetail(merged);
                  const stats = courseStats(merged);
                  setCourses((previous) =>
                    previous.map((item) =>
                      item.id === courseId
                        ? {
                            ...item,
                            generatedCount: stats.generatedCount,
                            updatedAt: Date.now(),
                            status: stats.generatedCount >= stats.total ? 'complete' : 'generating',
                          }
                        : item,
                    ),
                  );
                }
              }
              if (mountedRef.current) {
                setGeneration((previous) =>
                  previous === null
                    ? previous
                    : {
                        ...previous,
                        done: step + 1,
                        job:
                          previous.job === null || previous.job === undefined
                            ? previous.job
                            : { ...previous.job, status: 'succeeded' },
                      },
                );
              }
              completed += 1;
            }
          } finally {
            engine.running = false;
            engine.jobId = null;
            engine.controller = null;
          }

          if (!mountedRef.current || engine.runId !== runId) return;
          const cancelled = engine.cancel && completed < queue.length;
          engine.cancel = false;
          setGeneration(null);

          const warningSuffix =
            runWarnings.size > 0
              ? `（提示：${[...runWarnings].slice(0, 2).join('；')}${runWarnings.size > 2 ? ` 等 ${runWarnings.size} 条` : ''}）`
              : '';
          if (cancelled) {
            setNotice({ kind: 'info', text: '已取消生成；已完成的章节会保留。' });
          } else if (queue.length === 1) {
            setNotice({ kind: 'success', text: `第 ${queue[0] + 1} 章已生成。${warningSuffix}` });
          } else {
            setNotice({ kind: 'success', text: `已完成 ${queue.length} 个章节的生成。${warningSuffix}` });
          }

          if (selectedIdRef.current === courseId) {
            void loadDetail(courseId, { silent: true });
          }
          void callApi('state')
            .then((result) => {
              if (!mountedRef.current) return;
              const list = Array.isArray(result.courses) ? result.courses : [];
              setCourses(list);
              if (typeof result.dataDir === 'string') setDataDir(result.dataDir);
            })
            .catch(() => {
              /* list refresh is best-effort; detail data is already merged */
            });
        },
        [loadDetail],
      );

      const cancelGeneration = React.useCallback(() => {
        const engine = generationRef.current;
        if (!engine.running) return;
        engine.cancel = true;
        setGeneration((previous) =>
          previous === null ? previous : { ...previous, cancelRequested: true },
        );
        const jobId = engine.jobId;
        const runId = engine.runId;
        if (typeof jobId === 'string' && jobId !== '') {
          void cancelChapterJob(jobId)
            .then((job) => {
              if (!mountedRef.current || !engine.running || engine.runId !== runId || job === null) return;
              setGeneration((previous) =>
                previous === null ? previous : { ...previous, job, cancelRequested: true },
              );
            })
            .catch(() => {
              if (engine.controller !== null) {
                try {
                  engine.controller.abort();
                } catch (error) {
                  /* already aborted */
                }
              }
            });
        }
      }, []);

      const dismissGeneration = React.useCallback(() => {
        if (generationRef.current.running) return;
        setGeneration(null);
      }, []);

      const retryFailedChapter = React.useCallback(() => {
        const state = generation;
        if (state === null || !Number.isInteger(state.failedIndex)) return;
        setGeneration(null);
        void runGeneration(state.courseId, [state.failedIndex], state.courseTitle);
      }, [generation, runGeneration]);

      const continueAfterFailure = React.useCallback(() => {
        const state = generation;
        if (state === null || !Number.isInteger(state.failedStep)) return;
        const remaining = state.indices.slice(state.failedStep + 1);
        setGeneration(null);
        if (remaining.length === 0) {
          setNotice({ kind: 'info', text: '失败章节之后没有待生成的章节了。' });
          return;
        }
        void runGeneration(state.courseId, remaining, state.courseTitle);
      }, [generation, runGeneration]);

      const generateAll = React.useCallback(() => {
        if (detail === null || generationRef.current.running) return;
        const stats = courseStats(detail);
        const openMissing = stats.missing.filter((index) => chapterIsUnlocked(detail, index));
        if (openMissing.length === 0) {
          setNotice({
            kind: 'info',
            text:
              stats.missing.length === 0
                ? '所有章节都已生成。'
                : '当前已解锁的章节都已生成；完成学习任务解锁更多章节后再继续。',
          });
          return;
        }
        void runGeneration(detail.id, openMissing);
      }, [detail, runGeneration]);

      const generateChapter = React.useCallback(
        (index) => {
          if (detail === null || generationRef.current.running) return;
          if (!chapterIsUnlocked(detail, index)) {
            setNotice({ kind: 'error', text: `第 ${index + 1} 章尚未解锁：${unlockHintFor(detail, index)}` });
            return;
          }
          void runGeneration(detail.id, [index]);
        },
        [detail, runGeneration],
      );

      const openChapter = React.useCallback((index) => {
        setReviewIndex(null);
        setDetailTab('chapters');
        setSidebarCollapsed(true);
        setReaderIndex(index);
        setActiveChapter(index);
      }, []);

      const backToCourse = React.useCallback(() => {
        setReaderIndex(null);
      }, []);

      const startReview = React.useCallback((index) => {
        setReaderIndex(null);
        setSidebarCollapsed(true);
        setReviewIndex(index);
        setDetailTab('review');
      }, []);

      const backFromReview = React.useCallback(() => {
        setReviewIndex(null);
      }, []);

      const generateGraph = React.useCallback(async (force) => {
        const course = detailRef.current;
        if (course === null || course === undefined || graphBusy) return;
        if (generationRef.current.running) {
          setNotice({ kind: 'info', text: '正在生成章节，请稍后再生成知识图谱。' });
          return;
        }
        const courseId = course.id;
        const requestId = graphRequestRef.current + 1;
        graphRequestRef.current = requestId;
        setGraphBusy(true);
        try {
          const result = await callApi('graph', { id: courseId, force: Boolean(force) });
          if (!mountedRef.current) return;
          const graph = result.graph !== null && result.graph !== undefined ? result.graph : null;
          if (detailRef.current !== null && detailRef.current.id === courseId) {
            const nextCourse = { ...detailRef.current, graph };
            detailRef.current = nextCourse;
            setDetail(nextCourse);
          }
          setCourses((previous) =>
            previous.map((item) => (item.id === courseId ? { ...item, hasGraph: graph !== null } : item)),
          );
          setNotice({
            kind: 'success',
            text:
              graph !== null && graph.source === 'derived'
                ? '知识图谱已生成（当前为按章节推导的基础关系）。'
                : '知识图谱已生成。',
          });
        } catch (error) {
          if (mountedRef.current) {
            setNotice({
              kind: 'error',
              text: `知识图谱生成失败：${error && error.message ? error.message : '未知错误'}`,
            });
          }
        } finally {
          if (mountedRef.current && graphRequestRef.current === requestId) setGraphBusy(false);
        }
      }, [graphBusy]);

      const goPrev = React.useCallback(() => {
        if (readerIndex === null || readerIndex <= 0) return;
        const next = readerIndex - 1;
        setReaderIndex(next);
        setActiveChapter(next);
      }, [readerIndex]);

      const goNext = React.useCallback(() => {
        if (readerIndex === null) return;
        const next = readerIndex + 1;
        setReaderIndex(next);
        setActiveChapter(next);
      }, [readerIndex]);

      const filteredCourses = React.useMemo(() => {
        const keyword = search.trim().toLowerCase();
        if (keyword === '') return courses;
        return courses.filter((course) => {
          const haystack = `${typeof course.title === 'string' ? course.title : ''} ${
            typeof course.topic === 'string' ? course.topic : ''
          }`.toLowerCase();
          return haystack.includes(keyword);
        });
      }, [courses, search]);

      const selectedCourse = detail !== null && detail.id === selectedId ? detail : null;
      const selectedProgressEntry = selectedId !== null ? progress[selectedId] : undefined;
      const running = Boolean(generation !== null && generation.running);
      const generationForSelection = generation;

      const chapterList =
        selectedCourse !== null && Array.isArray(selectedCourse.chapters) ? selectedCourse.chapters : [];
      const readingChapter =
        readerIndex !== null && selectedCourse !== null ? chapterList[readerIndex] || null : null;
      const totalChapters = selectedCourse !== null ? courseStats(selectedCourse).total : 0;
      const canPrev = readerIndex !== null && readerIndex > 0 && Boolean(chapterList[readerIndex - 1]);
      const canNext =
        readerIndex !== null && readerIndex + 1 < totalChapters && Boolean(chapterList[readerIndex + 1]);
      const readerDone = (() => {
        if (selectedId === null || readerIndex === null) return false;
        const entry = normalizeProgressEntry(progress[selectedId]);
        return entry.done.includes(readerIndex);
      })();
      const readerQuizResult = (() => {
        if (selectedId === null || readerIndex === null) return null;
        const entry = normalizeProgressEntry(progress[selectedId]);
        return entry.quiz[String(readerIndex)] || null;
      })();
      const reviewChapter =
        reviewIndex !== null && selectedCourse !== null ? chapterList[reviewIndex] || null : null;
      const reviewInfo =
        selectedCourse !== null ? reviewChapterItems(selectedCourse, selectedProgressEntry, Date.now()) : null;
      const reviewDueCount = reviewInfo !== null ? reviewInfo.due.length : 0;
      const reviewQuizResult = (() => {
        if (selectedId === null || reviewIndex === null) return null;
        const entry = normalizeProgressEntry(progress[selectedId]);
        return entry.quiz[String(reviewIndex)] || null;
      })();

      const renderPlaceholder = () =>
        h(
          'div',
          { className: 'ls-panel' },
          h(
            'div',
            { className: 'ls-placeholder' },
            h(BookIcon, { size: 44 }),
            h(
              'div',
              { className: 'ls-placeholder-title' },
              courses.length === 0 ? '还没有课程' : '选择一门课程开始学习',
            ),
            h(
              'p',
              { className: 'ls-placeholder-text' },
              courses.length === 0
                ? '点击「新建课程」，填写主题后 AI 会设计出完整的学习大纲，再逐章生成内容。'
                : '从左侧列表选择课程，查看章节大纲、生成章节内容，或继续上次的阅读进度。',
            ),
            courses.length === 0
              ? h(
                  'button',
                  { type: 'button', className: 'ls-btn ls-btn-primary', onClick: () => setComposeOpen(true) },
                  '新建第一门课程',
                )
              : null,
          ),
        );

      const renderRightPane = () => {
        if (composeOpen) {
          return h(CreateCoursePanel, {
            onCreated: handleOutlineCreated,
            onCancel: () => setComposeOpen(false),
          });
        }
        if (bootPhase === 'loading') {
          return h(
            'div',
            { className: 'ls-panel' },
            h('div', { className: 'ls-loading' }, h(Spinner, null), '正在加载学习空间…'),
          );
        }
        if (bootPhase === 'error') {
          return h(
            'div',
            { className: 'ls-panel' },
            h(
              'div',
              { className: 'ls-placeholder' },
              h(BookIcon, { size: 36 }),
              h('div', { className: 'ls-placeholder-title' }, '无法加载学习空间'),
              h('p', { className: 'ls-placeholder-text' }, bootError || '请检查 Harness 宿主后重试。'),
              h('button', { type: 'button', className: 'ls-btn ls-btn-primary', onClick: () => void bootstrap() }, '重试'),
            ),
          );
        }
        if (selectedId === null) return renderPlaceholder();
        if (readingChapter !== null && selectedCourse !== null) {
          return h(ChapterReader, {
            course: selectedCourse,
            chapter: readingChapter,
            index: readerIndex,
            total: totalChapters,
            canPrev,
            canNext,
            isDone: readerDone,
            quizResult: readerQuizResult,
            katexReady,
            prismReady,
            onBack: backToCourse,
            onPrev: goPrev,
            onNext: goNext,
            onToggleDone: () => toggleDone(selectedId, readerIndex),
            onRecordQuiz: (index, result) => recordQuiz(selectedId, index, result),
            onToast: setNotice,
            onRefreshDetail: refreshSelectedCourse,
          });
        }
        if (reviewChapter !== null && selectedCourse !== null) {
          return h(ReviewSession, {
            course: selectedCourse,
            chapter: reviewChapter,
            index: reviewIndex,
            quizResult: reviewQuizResult,
            graph: selectedCourse.graph,
            onBack: backFromReview,
            onRecordQuiz: (index, result) => recordQuiz(selectedId, index, result),
          });
        }
        if (selectedCourse !== null) {
          return h(CourseDetailPanel, {
            course: selectedCourse,
            progressEntry: selectedProgressEntry,
            generation: generationForSelection,
            activeChapter,
            tab: detailTab,
            reviewDue: reviewDueCount,
            graphBusy,
            onTabChange: setDetailTab,
            onGenerateAll: generateAll,
            onGenerateChapter: generateChapter,
            onRead: openChapter,
            onGoChapter: openChapter,
            onGenerateGraph: (force) => void generateGraph(force),
            onStartReview: startReview,
            onToast: setNotice,
            onRefreshDetail: refreshSelectedCourse,
            katexReady,
            prismReady,
          });
        }
        if (detailPhase === 'error') {
          return h(
            'div',
            { className: 'ls-panel' },
            h(
              'div',
              { className: 'ls-placeholder' },
              h(BookIcon, { size: 36 }),
              h('div', { className: 'ls-placeholder-title' }, '课程加载失败'),
              h('p', { className: 'ls-placeholder-text' }, detailError || '请稍后重试。'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-primary',
                  onClick: () => {
                    if (selectedId !== null) void loadDetail(selectedId, { silent: false });
                  },
                },
                '重试',
              ),
            ),
          );
        }
        return h(
          'div',
          { className: 'ls-panel' },
          h('div', { className: 'ls-loading' }, h(Spinner, null), '正在加载课程…'),
        );
      };

      const renderSidebarList = () => {
        if (bootPhase === 'loading') {
          return h(
            'div',
            { className: 'ls-list' },
            h('div', { className: 'ls-skeleton-card' }),
            h('div', { className: 'ls-skeleton-card' }),
            h('div', { className: 'ls-skeleton-card' }),
          );
        }
        if (bootPhase === 'error') {
          return h(
            'div',
            { className: 'ls-empty' },
            h(BookIcon, { size: 34 }),
            h('div', { className: 'ls-empty-title' }, '加载失败'),
            h('p', { className: 'ls-empty-text' }, bootError || '无法加载课程列表。'),
            h('button', { type: 'button', className: 'ls-btn', onClick: () => void bootstrap() }, '重试'),
          );
        }
        if (courses.length === 0) {
          return h(
            'div',
            { className: 'ls-empty' },
            h(BookIcon, { size: 34 }),
            h('div', { className: 'ls-empty-title' }, '还没有课程'),
            h('p', { className: 'ls-empty-text' }, '让 AI 根据你的主题，生成一门有章节、有测验的课程。'),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-primary',
                onClick: () => setComposeOpen(true),
              },
              '新建第一门课程',
            ),
          );
        }
        if (filteredCourses.length === 0) {
          return h(
            'div',
            { className: 'ls-empty' },
            h('div', { className: 'ls-empty-title' }, '没有匹配的课程'),
            h('p', { className: 'ls-empty-text' }, '换个关键词试试，或清空搜索框。'),
          );
        }
        return h(
          'div',
          { className: 'ls-list' },
          filteredCourses.map((course) =>
            h(CourseCard, {
              key: course.id,
              course,
              selected: selectedId === course.id,
              progressEntry: progress[course.id],
              confirming: deleteId === course.id,
              deleting: deletingId === course.id,
              onSelect: () => selectCourse(course.id),
              onRequestDelete: () => requestDelete(course.id),
              onCancelDelete: cancelDelete,
              onConfirmDelete: () => void confirmDelete(course.id),
            }),
          ),
        );
      };

      return h(
        'div',
        { className: 'ls-page' },
        h('style', null, LS_CSS),
        h(
          'header',
          { className: 'ls-header' },
          h(
            'div',
            { className: 'ls-header-main' },
            h('h1', { className: 'ls-title' }, '学习空间'),
            h(
              'p',
              { className: 'ls-subtitle', title: dataDir !== '' ? dataDir : undefined },
              dataDir !== '' ? `数据目录：${dataDir}` : 'AI 生成课程 · 章节阅读 · 章末测验',
            ),
          ),
          h(
            'div',
            { className: 'ls-header-actions' },
            selectedId !== null && sidebarCollapsed
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn',
                    onClick: () => setSidebarCollapsed(false),
                    title: '展开课程列表',
                  },
                  '课程列表',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn',
                onClick: () => void refreshAll(),
                disabled: refreshing || running || graphBusy,
                title: running ? '章节生成中，请稍候' : graphBusy ? '知识图谱生成中，请稍候' : '重新加载课程列表',
              },
              refreshing ? h(Spinner, null) : h(RefreshIcon, null),
              '刷新',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ls-btn ls-btn-primary',
                onClick: () => {
                  setComposeOpen(true);
                  setReaderIndex(null);
                  setReviewIndex(null);
                },
                disabled: composeOpen || running || graphBusy,
                title: running ? '章节生成中，请稍候' : graphBusy ? '知识图谱生成中，请稍候' : '新建课程',
              },
              h(PlusIcon, null),
              '新建课程',
            ),
          ),
        ),
        h(NoticeBanner, { notice, onClose: () => setNotice(null) }),
        h(
          'div',
          { className: 'ls-body' },
          sidebarCollapsed ? null : h(
            'aside',
            { className: 'ls-sidebar' },
            h(
              'div',
              { className: 'ls-sidebar-top' },
              h('input', {
                className: 'ls-search',
                type: 'search',
                value: search,
                placeholder: '搜索课程标题',
                'aria-label': '搜索课程',
                disabled: bootPhase !== 'ready',
                onChange: (event) => setSearch(event.target.value),
              }),
              h(
                'div',
                { className: 'ls-sidebar-meta' },
                h(
                  'span',
                  { className: 'ls-sidebar-count' },
                  search.trim() !== '' ? `找到 ${filteredCourses.length} 门课程` : `共 ${courses.length} 门课程`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn ls-btn-sm ls-btn-ghost ls-sidebar-toggle',
                    onClick: () => setSidebarCollapsed(true),
                    title: '折叠课程列表',
                    'aria-label': '折叠课程列表',
                  },
                  '«',
                ),
              ),
            ),
            renderSidebarList(),
          ),
          h(
            'section',
            { className: 'ls-main' },
            h(GenerationStatus, {
              state: generationForSelection,
              showCourseTitle:
                generationForSelection !== null && generationForSelection.courseId !== selectedId,
              onCancel: cancelGeneration,
              onRetry: retryFailedChapter,
              onContinue: continueAfterFailure,
              onDismiss: dismissGeneration,
            }),
            renderRightPane(),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Plugin registration                                               */
    /* ---------------------------------------------------------------- */

    const inject = ['slots'];

    /**
     * Inject the vendored KaTeX stylesheet and script once, and clean them up
     * when the plugin disposes. A failed load only disables math rendering;
     * the page keeps working and falls back to raw TeX.
     */
    function installKatexAssets() {
      if (typeof document === 'undefined' || document.head === null) return undefined;
      const cleanups = [];

      const existingCss = document.querySelector(`link[${VENDOR_ATTR}="katex"]`);
      if (existingCss === null) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = KATEX_CSS_HREF;
        link.setAttribute(VENDOR_ATTR, 'katex');
        document.head.appendChild(link);
        cleanups.push(() => {
          try {
            link.remove();
          } catch (error) {
            /* already detached */
          }
        });
      }

      const needsScript = typeof window === 'undefined' || typeof window.katex === 'undefined';
      let script = document.querySelector(`script[${VENDOR_ATTR}="katex"]`);
      if (needsScript && script === null) {
        script = document.createElement('script');
        script.src = KATEX_JS_SRC;
        script.async = true;
        script.setAttribute(VENDOR_ATTR, 'katex');
        const onLoad = () => {
          try {
            window.dispatchEvent(new CustomEvent(KATEX_READY_EVENT));
          } catch (error) {
            /* event delivery is best-effort */
          }
        };
        const onError = () => {
          try {
            window.dispatchEvent(new CustomEvent(KATEX_FAILED_EVENT));
          } catch (error) {
            /* event delivery is best-effort */
          }
        };
        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
        document.head.appendChild(script);
        cleanups.push(() => {
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
          try {
            script.remove();
          } catch (error) {
            /* already detached */
          }
        });
      }

      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    }

    /**
     * Inject the vendored Prism bundle once and clean it up on disposal. A failed
     * load only disables highlighting; code blocks then render as plain text.
     */
    function installPrismAssets() {
      if (typeof document === 'undefined' || document.head === null) return undefined;
      if (
        typeof window !== 'undefined' &&
        window.Prism !== null &&
        window.Prism !== undefined &&
        typeof window.Prism.highlight === 'function'
      ) {
        return undefined;
      }
      if (document.querySelector(`script[${VENDOR_ATTR}="prism"]`) !== null) return undefined;

      const script = document.createElement('script');
      script.src = PRISM_JS_SRC;
      script.async = true;
      // Disable Prism's own highlightAll: React owns the code DOM, we only use
      // Prism.highlight() to produce HTML strings.
      script.setAttribute('data-manual', '');
      script.setAttribute(VENDOR_ATTR, 'prism');
      const onLoad = () => {
        try {
          window.dispatchEvent(new CustomEvent(PRISM_READY_EVENT));
        } catch (error) {
          /* event delivery is best-effort */
        }
      };
      const onError = () => {
        try {
          window.dispatchEvent(new CustomEvent(PRISM_FAILED_EVENT));
        } catch (error) {
          /* event delivery is best-effort */
        }
      };
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      document.head.appendChild(script);

      return () => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        try {
          script.remove();
        } catch (error) {
          /* already detached */
        }
      };
    }

    function apply(ctx) {
      ctx.effect(() => installKatexAssets(), 'learning-space: katex assets');
      ctx.effect(() => installPrismAssets(), 'learning-space: prism assets');
      ctx.effect(() => () => disposeMermaidAssets(), 'learning-space: mermaid assets');
      ctx.effect(() => () => disposeD3Assets(), 'learning-space: d3 assets');
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'learning-space', order: 30, label: '学习空间' },
          SpaceIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'learning-space' }, LearningSpacePage),
      );
    }

    return { inject, apply };
  },
});
