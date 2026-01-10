import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import * as XLSX from 'xlsx'

type MatchType = 'exact' | 'raw'

type ParsedPair = {
  studentId: string
  name: string
  rawStudentId: string
  rawName: string
  score: number
  matchType: MatchType
  confidence: number
  source: string
}

type Entry = {
  id: string
  studentId: string
  name: string
  score: number | ''
}

type GeminiRosterMode = 'append' | 'replace'

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
  }>
}

type GeminiModelInfo = {
  name: string // e.g. "models/gemini-2.0-flash"
  displayName?: string
  description?: string
  supportedGenerationMethods?: string[]
}

const GEMINI_CUSTOM_MODEL = '__custom__'
const GEMINI_MANUAL_PRESETS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
] as const

function isAbortError(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError'
}

type RosterItem = {
  studentId: string
  name: string
}

function normalizeGeminiModelSegment(model: string) {
  const m = model.trim()
  if (!m) return ''
  return m.startsWith('models/') ? m.slice('models/'.length) : m
}

function geminiModelDisplayName(modelName: string) {
  return modelName.replace(/^models\//, '')
}

async function geminiListModels(params: {
  apiKey: string
  signal?: AbortSignal
}): Promise<GeminiModelInfo[]> {
  const { apiKey, signal } = params
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(endpoint, { signal })
  if (!res.ok) {
    let details = ''
    try {
      details = JSON.stringify(await res.json())
    } catch {
      details = await res.text()
    }
    throw new Error(`获取 Gemini 模型列表失败：HTTP ${res.status} ${res.statusText}${details ? ` - ${details}` : ''}`)
  }
  const data = (await res.json()) as { models?: GeminiModelInfo[] }
  return data.models ?? []
}

function rosterItemsToText(items: RosterItem[]) {
  return items
    .map((it) => {
      const id = normalizeStudentId(it.studentId)
      const name = normalizeStudentName(it.name)
      if (!name) return ''
      return id ? `${id}\t${name}` : name
    })
    .filter(Boolean)
    .join('\n')
}

function safeTodayISO() {
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function uid() {
  if ('randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function normalizeStudentId(raw: string) {
  return raw.replace(/[^\d]/g, '').trim()
}

function normalizeStudentName(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/[，,。.\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\d+\s*/g, '') // strip leading index
    .replace(/^(姓名|名字|学号|學號)[:：]\s*/g, '')
    .replace(/(同学|同學)$/g, '')
    .trim()

  const onlyZh = cleaned.replace(/[^\u4e00-\u9fa5]/g, '')
  return (onlyZh || cleaned).trim()
}

function parseRosterLine(line: string): RosterItem | null {
  const s = line.trim()
  if (!s) return null
  // Common patterns:
  // - "202401 张三"
  // - "张三 202401"
  // - "张三"
  const tokens = s.split(/[\s,，;；]+/g).filter(Boolean)
  let id = ''
  let name = ''

  for (const t of tokens) {
    const maybeId = normalizeStudentId(t)
    const maybeName = normalizeStudentName(t)
    if (!id && maybeId && maybeId.length >= 4) id = maybeId
    if (!name && maybeName && /[\u4e00-\u9fa5]{2,8}/.test(maybeName)) name = maybeName
  }

  if (!name) {
    // fallback: try extracting name from whole line
    const n = normalizeStudentName(s)
    if (n && /[\u4e00-\u9fa5]{2,8}/.test(n)) name = n
  }
  if (!id) {
    // fallback: first long digit sequence
    const m = s.match(/\d{4,}/)
    if (m) id = normalizeStudentId(m[0])
  }
  if (!name) return null
  return { studentId: id, name }
}

function normalizeRoster(text: string): RosterItem[] {
  const items = text
    .split(/\r?\n/g)
    .map((s) => parseRosterLine(s))
    .filter((x): x is RosterItem => Boolean(x))

  // Dedupe: prefer studentId; otherwise by name
  const byId = new Map<string, RosterItem>()
  const byName = new Map<string, RosterItem>()
  for (const it of items) {
    const id = normalizeStudentId(it.studentId)
    const name = normalizeStudentName(it.name)
    const normalized: RosterItem = { studentId: id, name }
    if (id) byId.set(id, normalized)
    else byName.set(name, normalized)
  }
  const merged = [...byId.values()]
  for (const it of byName.values()) {
    // if same name already exists with id, skip
    if (merged.some((x) => x.name === it.name)) continue
    merged.push(it)
  }
  return merged
}

function normalizeTranscript(text: string) {
  const noise = [
    '今天',
    '语文',
    '作业',
    '同学',
    '同學',
    '分数',
    '成绩',
    '成績',
    '得了',
    '得',
    '是',
    '为',
    '分',
    '，',
    ',',
    '。',
    '.',
    '、',
    '：',
    ':',
    '；',
    ';',
    '（',
    '(',
    '）',
    ')',
    '【',
    '[',
    '】',
    ']',
    '“',
    '"',
    '”',
    '"',
    '？',
    '?',
    '！',
    '!',
  ]
  let out = text
  for (const w of noise) out = out.split(w).join(' ')
  return out.replace(/\s+/g, ' ').trim()
}

function chineseToNumber(raw: string) {
  const s = raw.replace(/分/g, '').trim()
  if (!s) return null
  if (/^\d{1,3}$/.test(s)) return Number.parseInt(s, 10)

  // Basic Chinese numerals up to 999
  const digit: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }

  const chars = Array.from(s)
  let total = 0
  let current = 0
  let seenAny = false

  const flushUnit = (unit: number) => {
    if (!seenAny) return
    if (current === 0) current = 1 // e.g. "十" -> 10
    total += current * unit
    current = 0
  }

  for (const ch of chars) {
    if (ch in digit) {
      current = digit[ch]
      seenAny = true
      continue
    }
    if (ch === '百') {
      seenAny = true
      flushUnit(100)
      continue
    }
    if (ch === '十') {
      seenAny = true
      flushUnit(10)
      continue
    }
    // ignore unknown chars
  }
  if (!seenAny) return null
  total += current
  return total
}

function clampScore(n: number) {
  if (Number.isNaN(n)) return null
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

function parsePairsFromText(text: string, roster: RosterItem[]): ParsedPair[] {
  const normalized = normalizeTranscript(text)
  if (!normalized) return []

  const results: ParsedPair[] = []
  // e.g.
  // - "张三 95"
  // - "202401 95"
  // - "李四九十五分"
  const re =
    /((?:\d{4,}|[\u4e00-\u9fa5]{2,8}))\s*(?:得|是|为)?\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*(?:分)?/g
  for (const match of normalized.matchAll(re)) {
    const rawIdOrName = (match[1] ?? '').trim()
    const rawScore = (match[2] ?? '').trim()
    const num = chineseToNumber(rawScore)
    if (num === null) continue
    const score = clampScore(num)
    if (score === null) continue

    const rawStudentId = normalizeStudentId(rawIdOrName)
    const rawName = normalizeStudentName(rawIdOrName)

    let matched: { studentId: string; name: string; matchType: MatchType; confidence: number } = {
      studentId: rawStudentId,
      name: rawName || rawIdOrName,
      matchType: 'raw',
      confidence: 0,
    }

    if (rawStudentId) {
      const byId = roster.find((r) => r.studentId && r.studentId === rawStudentId)
      if (byId) matched = { studentId: byId.studentId, name: byId.name, matchType: 'exact', confidence: 1 }
    } else if (rawName) {
      const byName = roster.find((r) => r.name === rawName)
      if (byName) matched = { studentId: byName.studentId, name: byName.name, matchType: 'exact', confidence: 1 }
    }

    results.push({
      studentId: matched.studentId,
      name: matched.name,
      rawStudentId,
      rawName,
      score,
      matchType: matched.matchType,
      confidence: matched.confidence,
      source: match[0] ?? '',
    })
  }

  // De-duplicate by studentId if available, else by name
  const byKey = new Map<string, ParsedPair>()
  for (const item of results) {
    const key = item.studentId ? `id:${item.studentId}` : `name:${item.name}`
    byKey.set(key, item)
  }
  return Array.from(byKey.values())
}

function exportToExcel(params: {
  date: string
  homeworkTitle: string
  entries: Entry[]
}) {
  const { date, homeworkTitle, entries } = params
  const clean = entries
    .filter((e) => e.name.trim() && e.score !== '')
    .map((e) => ({ studentId: e.studentId.trim(), name: e.name.trim(), score: Number(e.score) }))
    .sort((a, b) => {
      const aid = a.studentId || ''
      const bid = b.studentId || ''
      if (aid && bid) return aid.localeCompare(bid, 'en')
      if (aid) return -1
      if (bid) return 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })

  const aoa: (string | number)[][] = [
    ['语文作业成绩登记表'],
    ['日期', date, '作业', homeworkTitle || '（未填写）'],
    [],
    ['学号', '姓名', '成绩'],
    ...clean.map((r) => [r.studentId, r.name, r.score]),
  ]

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 24 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '登记表')

  const filename = `语文作业成绩_${date}.xlsx`
  XLSX.writeFile(wb, filename)
}

function uniqueNames(names: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const cleaned = normalizeStudentName(n)
    if (!cleaned) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}

function uniqueRosterItems(items: RosterItem[]) {
  const byId = new Map<string, RosterItem>()
  const byName = new Map<string, RosterItem>()
  for (const it of items) {
    const id = normalizeStudentId(it.studentId)
    const name = normalizeStudentName(it.name)
    if (!name) continue
    const normalized: RosterItem = { studentId: id, name }
    if (id) byId.set(id, normalized)
    else byName.set(name, normalized)
  }
  const merged = [...byId.values()]
  for (const it of byName.values()) {
    if (merged.some((x) => x.name === it.name)) continue
    merged.push(it)
  }
  return merged
}

function extractJsonArrayFromText(text: string) {
  const trimmed = text.trim()
  // Prefer full JSON array
  const firstArr = trimmed.indexOf('[')
  const lastArr = trimmed.lastIndexOf(']')
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    const json = trimmed.slice(firstArr, lastArr + 1)
    return json
  }
  return null
}

async function geminiParseHomeworkScores(params: {
  apiKey: string
  model: string
  transcript: string
  roster: RosterItem[]
  signal?: AbortSignal
}): Promise<Array<{ studentId: string; name: string; score: number }>> {
  const { apiKey, model, transcript, roster, signal } = params
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    normalizeGeminiModelSegment(model),
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const prompt = [
    '你是语文老师的“作业成绩语音录入助手”。',
    '给你两份输入：1) 花名册（包含学号 studentId 与姓名 name）2) 老师口述成绩的识别文本。',
    '任务：从识别文本中提取每个学生的成绩，并把“学号或姓名”映射为花名册中的学生。',
    '',
    '强约束：',
    '1) 只输出 JSON 数组，不要任何额外文字',
    '2) 数组元素是对象：{"studentId":"<花名册里的studentId，可为空字符串>","name":"<花名册里的name>","score":<0-100整数>}',
    '3) name 必须严格来自花名册；studentId 必须与该 name 对应（若花名册中该学生学号为空，则 studentId 也输出空字符串）',
    '4) 允许老师用“学号”或“姓名”报分；但输出必须是花名册中的标准记录',
    '4) 同一学生出现多次取“最后一次”成绩',
    '5) 过滤噪声词（如：语文/作业/成绩/分数/今天/同学/得了/是/为等）',
    '',
    '花名册：',
    JSON.stringify(roster),
    '',
    '识别文本：',
    transcript,
  ].join('\n')

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 1024,
      },
    }),
  })

  if (!res.ok) {
    let details = ''
    try {
      details = JSON.stringify(await res.json())
    } catch {
      details = await res.text()
    }
    throw new Error(`Gemini API 请求失败：HTTP ${res.status} ${res.statusText}${details ? ` - ${details}` : ''}`)
  }

  const data = (await res.json()) as GeminiGenerateContentResponse
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p.text ?? '')
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n')

  const jsonArr = extractJsonArrayFromText(text)
  if (!jsonArr) return []

  const parsed = JSON.parse(jsonArr) as unknown
  if (!Array.isArray(parsed)) return []

  const rosterByName = new Map<string, RosterItem>()
  const rosterById = new Map<string, RosterItem>()
  for (const r of roster) {
    if (r.name) rosterByName.set(r.name, r)
    if (r.studentId) rosterById.set(r.studentId, r)
  }

  const byKey = new Map<string, { studentId: string; name: string; score: number }>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const name = normalizeStudentName(String((item as { name?: unknown }).name ?? ''))
    const studentId = normalizeStudentId(String((item as { studentId?: unknown }).studentId ?? ''))
    const scoreRaw = (item as { score?: unknown }).score
    const scoreNum = typeof scoreRaw === 'number' ? scoreRaw : Number(scoreRaw)
    if (!name) continue
    if (!Number.isFinite(scoreNum)) continue
    const s = clampScore(Math.round(scoreNum))
    if (s === null) continue

    const matchedById = studentId ? rosterById.get(studentId) : undefined
    const matchedByName = rosterByName.get(name)
    const matched = matchedById ?? matchedByName
    if (!matched) continue

    // Ensure name aligns with roster record
    if (matched.name !== name) continue
    // Ensure id aligns with roster record (unless roster has no id)
    if (matched.studentId && matched.studentId !== studentId) continue

    const outId = matched.studentId || ''
    const key = outId ? `id:${outId}` : `name:${matched.name}`
    byKey.set(key, { studentId: outId, name: matched.name, score: s })
  }
  return Array.from(byKey.values())
}

async function geminiExtractRosterNamesWithExclusions(params: {
  apiKey: string
  model: string
  inputText: string
  existingNames: string[]
  signal?: AbortSignal
}): Promise<string[]> {
  const { apiKey, model, inputText, existingNames, signal } = params
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    normalizeGeminiModelSegment(model),
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const prompt = [
    '你是一个帮助语文老师整理“花名册”的助手。',
    '任务：从用户提供的原始文本中提取学生姓名，输出 JSON 数组（只输出 JSON，不要多余文字）。',
    '',
    '强约束：',
    '1) 只输出 JSON 数组，例如：["张三","李四"]',
    '2) 去除序号、班级、学号、括号备注、标点，保留姓名本体',
    '3) 过滤明显非姓名的词（如“语文/作业/成绩/名单/男/女/缺勤”等）',
    '4) 不要输出重复姓名',
    `5) 不要输出已存在的姓名（已有名单）：${JSON.stringify(existingNames)}`,
    '6) 如果无法确定，请保守处理，不要编造姓名',
    '',
    '原始文本：',
    inputText,
  ].join('\n')

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1024,
      },
    }),
  })

  if (!res.ok) {
    let details = ''
    try {
      details = JSON.stringify(await res.json())
    } catch {
      details = await res.text()
    }
    throw new Error(`Gemini API 请求失败：HTTP ${res.status} ${res.statusText}${details ? ` - ${details}` : ''}`)
  }

  const data = (await res.json()) as GeminiGenerateContentResponse
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p.text ?? '')
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n')

  const jsonArr = extractJsonArrayFromText(text)
  if (jsonArr) {
    try {
      const parsed = JSON.parse(jsonArr) as unknown
      if (Array.isArray(parsed)) return uniqueNames(parsed.map((x) => String(x)))
    } catch {
      // fallthrough to line parsing
    }
  }

  const fallback = text
    .split(/\r?\n/g)
    .map((s: string) => s.trim())
    .filter(Boolean)
  return uniqueNames(fallback)
}

async function geminiExtractRosterNames(params: {
  apiKey: string
  model: string
  inputText: string
  signal?: AbortSignal
}): Promise<string[]> {
  const { apiKey, model, inputText, signal } = params
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    normalizeGeminiModelSegment(model),
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const prompt = [
    '你是一个帮助语文老师整理“花名册”的助手。',
    '任务：从用户提供的原始文本中提取学生姓名，输出 JSON 数组（只输出 JSON，不要多余文字）。',
    '',
    '规则：',
    '1) 只输出 JSON 数组，例如：["张三","李四"]',
    '2) 去除序号、班级、学号、括号备注、标点，保留姓名本体',
    '3) 过滤明显非姓名的词（如“语文/作业/成绩/名单/男/女/缺勤”等）',
    '4) 不要输出重复姓名',
    '5) 如果无法确定，请尽量保守，不要编造姓名',
    '',
    '原始文本：',
    inputText,
  ].join('\n')

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1024,
      },
    }),
  })

  if (!res.ok) {
    let details = ''
    try {
      details = JSON.stringify(await res.json())
    } catch {
      details = await res.text()
    }
    throw new Error(`Gemini API 请求失败：HTTP ${res.status} ${res.statusText}${details ? ` - ${details}` : ''}`)
  }

  const data = (await res.json()) as GeminiGenerateContentResponse
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p.text ?? '')
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n')
  const jsonArr = extractJsonArrayFromText(text)
  if (jsonArr) {
    try {
      const parsed = JSON.parse(jsonArr) as unknown
      if (Array.isArray(parsed)) return uniqueNames(parsed.map((x) => String(x)))
    } catch {
      // fallthrough to line parsing
    }
  }

  // Fallback: parse as newline-separated
  const fallback = text
    .split(/\r?\n/g)
    .map((s: string) => s.trim())
    .filter(Boolean)
  return uniqueNames(fallback)
}

function App() {
  const [date, setDate] = useState(() => safeTodayISO())
  const [homeworkTitle, setHomeworkTitle] = useState('')
  const [rosterText, setRosterText] = useState(() => {
    const fromStorage = localStorage.getItem('rosterText')
    return (
      fromStorage ??
      ['张三', '李四', '王五', '赵六', '钱七', '孙八'].join('\n')
    )
  })

  const roster = useMemo(() => normalizeRoster(rosterText), [rosterText])
  const rosterNames = useMemo(() => roster.map((r) => r.name), [roster])
  const rosterIds = useMemo(() => roster.map((r) => r.studentId).filter(Boolean), [roster])
  const rosterById = useMemo(() => {
    const m = new Map<string, RosterItem>()
    for (const r of roster) if (r.studentId) m.set(r.studentId, r)
    return m
  }, [roster])
  const rosterNameCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of roster) m.set(r.name, (m.get(r.name) ?? 0) + 1)
    return m
  }, [roster])

  const [geminiApiKey, setGeminiApiKey] = useState(() => {
    const envKey = import.meta.env.VITE_GEMINI_API_KEY
    return envKey || localStorage.getItem('geminiApiKey') || ''
  })
  const [rememberGeminiKey, setRememberGeminiKey] = useState(() => Boolean(localStorage.getItem('geminiApiKey')))
  const [geminiModels, setGeminiModels] = useState<GeminiModelInfo[]>([])
  const [geminiModelsLoading, setGeminiModelsLoading] = useState(false)
  const [geminiModelsStatus, setGeminiModelsStatus] = useState('')
  const geminiModelsAbortRef = useRef<AbortController | null>(null)

  const [geminiModelChoice, setGeminiModelChoice] = useState(() => {
    const savedChoice = localStorage.getItem('geminiModelChoice')
    if (savedChoice) return savedChoice
    // backward compat with old keys:
    const oldPreset = localStorage.getItem('geminiModelPreset')
    const oldCustom = localStorage.getItem('geminiModelCustom') || ''
    if (oldPreset === 'custom') return GEMINI_CUSTOM_MODEL
    if (oldPreset) return oldPreset
    if (oldCustom) return GEMINI_CUSTOM_MODEL
    return 'gemini-2.0-flash'
  })
  const [geminiModelCustom, setGeminiModelCustom] = useState(() => localStorage.getItem('geminiModelCustom') || '')
  const geminiModel =
    geminiModelChoice === GEMINI_CUSTOM_MODEL ? geminiModelCustom.trim() : geminiModelChoice.trim()
  const [geminiInputText, setGeminiInputText] = useState('')
  const [geminiMode, setGeminiMode] = useState<GeminiRosterMode>('append')
  const [geminiPreview, setGeminiPreview] = useState<string[]>([])
  const [geminiStatus, setGeminiStatus] = useState('')
  const [geminiLoading, setGeminiLoading] = useState(false)
  const geminiAbortRef = useRef<AbortController | null>(null)
  const [useGeminiForMatching, setUseGeminiForMatching] = useState(() => {
    const saved = localStorage.getItem('useGeminiForMatching')
    return saved ? saved === '1' : true
  })
  const [geminiMatchLoading, setGeminiMatchLoading] = useState(false)
  const [geminiMatchStatus, setGeminiMatchStatus] = useState('')

  // AI realtime roster via voice
  const [rosterVoiceOn, setRosterVoiceOn] = useState(false)
  const [rosterVoiceFinal, setRosterVoiceFinal] = useState('')
  const [rosterVoiceInterim, setRosterVoiceInterim] = useState('')
  const [rosterVoiceStatus, setRosterVoiceStatus] = useState('')
  const [rosterVoiceAutoApply, setRosterVoiceAutoApply] = useState(true)
  const [rosterVoiceNewNames, setRosterVoiceNewNames] = useState<string[]>([])
  const rosterVoiceSnapshotRef = useRef<string>('')
  const rosterRecognitionRef = useRef<SpeechRecognition | null>(null)
  const rosterAiTimerRef = useRef<number | null>(null)
  const rosterAiAbortRef = useRef<AbortController | null>(null)
  const rosterAiLastHashRef = useRef<string>('')
  const [rosterAiLoading, setRosterAiLoading] = useState(false)
  const rosterTextRef = useRef(rosterText)
  const rosterVoiceNewNamesRef = useRef<string[]>([])
  const rosterVoiceAutoApplyRef = useRef(rosterVoiceAutoApply)
  const geminiKeyRef = useRef(geminiApiKey)
  const geminiModelRef = useRef(geminiModel)

  const [isRecording, setIsRecording] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [finalText, setFinalText] = useState('')
  const [interimText, setInterimText] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])

  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const supported = useMemo(() => {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  }, [])

  const liveText = (finalText + ' ' + interimText).trim()
  const parsedLive = useMemo(() => parsePairsFromText(liveText, roster), [liveText, roster])

  useEffect(() => {
    localStorage.setItem('rosterText', rosterText)
  }, [rosterText])

  useEffect(() => {
    rosterTextRef.current = rosterText
  }, [rosterText])

  useEffect(() => {
    rosterVoiceNewNamesRef.current = rosterVoiceNewNames
  }, [rosterVoiceNewNames])

  useEffect(() => {
    rosterVoiceAutoApplyRef.current = rosterVoiceAutoApply
  }, [rosterVoiceAutoApply])

  useEffect(() => {
    geminiKeyRef.current = geminiApiKey
  }, [geminiApiKey])

  useEffect(() => {
    geminiModelRef.current = geminiModel
  }, [geminiModel])

  useEffect(() => {
    localStorage.setItem('geminiModelChoice', geminiModelChoice)
  }, [geminiModelChoice])

  useEffect(() => {
    localStorage.setItem('geminiModelCustom', geminiModelCustom)
  }, [geminiModelCustom])

  useEffect(() => {
    localStorage.setItem('useGeminiForMatching', useGeminiForMatching ? '1' : '0')
  }, [useGeminiForMatching])

  const refreshGeminiModels = useCallback(async () => {
    setGeminiModelsStatus('')
    const key = geminiApiKey.trim()
    if (!key) {
      setGeminiModelsStatus('请先填写 Gemini API Key 后再获取模型列表。')
      return
    }
    geminiModelsAbortRef.current?.abort()
    const ac = new AbortController()
    geminiModelsAbortRef.current = ac
    setGeminiModelsLoading(true)
    try {
      const models = await geminiListModels({ apiKey: key, signal: ac.signal })
      const usable = models
        .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .sort((a, b) => geminiModelDisplayName(a.name).localeCompare(geminiModelDisplayName(b.name), 'en'))
      setGeminiModels(usable)
      const manualOk = new Set<string>(GEMINI_MANUAL_PRESETS as unknown as string[])
      const chosen = geminiModelChoice.trim()
      const chosenSupported =
        chosen === GEMINI_CUSTOM_MODEL
          ? true
          : usable.some((m) => geminiModelDisplayName(m.name) === chosen) || manualOk.has(chosen)
      setGeminiModelsStatus(
        usable.length
          ? `已加载 ${usable.length} 个可用模型。${chosenSupported ? '' : '（当前选择的模型可能不受此 Key 支持）'}`
          : '未找到支持 generateContent 的模型。',
      )
      if (usable.length) {
        // Do NOT auto-switch away from manual presets (e.g. gemini-1.5-flash).
        const currentChoice = geminiModelChoice.trim()
        const manualOk2 = new Set<string>(GEMINI_MANUAL_PRESETS as unknown as string[])
        if (currentChoice !== GEMINI_CUSTOM_MODEL && !manualOk2.has(currentChoice)) {
          const exists = usable.some((m) => geminiModelDisplayName(m.name) === currentChoice)
          if (!exists) setGeminiModelChoice(geminiModelDisplayName(usable[0].name))
        }
      }
    } catch (e) {
      if (isAbortError(e)) return
      setGeminiModelsStatus((e as Error).message || '获取模型列表失败。')
    } finally {
      setGeminiModelsLoading(false)
    }
  }, [geminiApiKey, geminiModelChoice])

  // Best-effort auto refresh when key changes
  useEffect(() => {
    if (!geminiApiKey.trim()) return
    void refreshGeminiModels()
  }, [geminiApiKey, refreshGeminiModels])

  useEffect(() => {
    if (!rememberGeminiKey) {
      localStorage.removeItem('geminiApiKey')
      return
    }
    if (geminiApiKey.trim()) localStorage.setItem('geminiApiKey', geminiApiKey.trim())
  }, [geminiApiKey, rememberGeminiKey])

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      recognitionRef.current = null
      geminiAbortRef.current?.abort()
      geminiAbortRef.current = null
      geminiModelsAbortRef.current?.abort()
      geminiModelsAbortRef.current = null
      rosterRecognitionRef.current?.abort()
      rosterRecognitionRef.current = null
      rosterAiAbortRef.current?.abort()
      rosterAiAbortRef.current = null
      if (rosterAiTimerRef.current) window.clearTimeout(rosterAiTimerRef.current)
    }
  }, [])

  const ensureRecognition = () => {
    if (recognitionRef.current) return recognitionRef.current
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Ctor) return null

    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (ev) => {
      let interim = ''
      let appendedFinal = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]
        const transcript = res[0]?.transcript ?? ''
        if (res.isFinal) appendedFinal += transcript
        else interim += transcript
      }
      if (appendedFinal) setFinalText((prev) => (prev ? `${prev} ${appendedFinal}` : appendedFinal))
      setInterimText(interim)
    }

    rec.onerror = (ev) => {
      setStatus(`识别错误：${ev.error}${ev.message ? `（${ev.message}）` : ''}`)
      setIsRecording(false)
    }

    rec.onend = () => {
      setIsRecording(false)
    }

    recognitionRef.current = rec
    return rec
  }

  const ensureRosterRecognition = () => {
    if (rosterRecognitionRef.current) return rosterRecognitionRef.current
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Ctor) return null

    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (ev) => {
      let interim = ''
      let appendedFinal = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]
        const transcript = res[0]?.transcript ?? ''
        if (res.isFinal) appendedFinal += transcript
        else interim += transcript
      }
      if (appendedFinal) setRosterVoiceFinal((prev) => (prev ? `${prev} ${appendedFinal}` : appendedFinal))
      setRosterVoiceInterim(interim)
    }

    rec.onerror = (ev) => {
      setRosterVoiceStatus(`语音识别错误：${ev.error}${ev.message ? `（${ev.message}）` : ''}`)
      setRosterVoiceOn(false)
    }

    rec.onend = () => {
      setRosterVoiceOn(false)
    }

    rosterRecognitionRef.current = rec
    return rec
  }

  const start = () => {
    setStatus('')
    if (!supported) {
      setStatus('当前浏览器不支持 Web Speech API（建议使用 Chrome）。')
      return
    }
    const rec = ensureRecognition()
    if (!rec) {
      setStatus('初始化语音识别失败。')
      return
    }
    setFinalText('')
    setInterimText('')
    setIsRecording(true)
    try {
      rec.start()
    } catch {
      // Some browsers throw if start() called too quickly
      setIsRecording(false)
      setStatus('启动识别失败：请稍后再试（或刷新页面）。')
    }
  }

  const rosterVoiceLiveText = (rosterVoiceFinal + ' ' + rosterVoiceInterim).trim()

  const runRosterAiExtractNow = useCallback(async (text: string) => {
    setRosterVoiceStatus('')
    const key = geminiKeyRef.current.trim()
    if (!key) {
      setRosterVoiceStatus('请先填写 Gemini API Key（用于 AI 实时提取姓名）。')
      return
    }
    const model = geminiModelRef.current
    if (!model) {
      setRosterVoiceStatus('请先选择 Gemini 模型。')
      return
    }
    if (!text.trim()) return

    // Very small "hash" to avoid repeated calls when transcript doesn't change meaningfully
    const compact = text.replace(/\s+/g, '').slice(-1800)
    const hash = `${compact.length}:${compact.slice(0, 40)}:${compact.slice(-40)}`
    if (hash === rosterAiLastHashRef.current) return
    rosterAiLastHashRef.current = hash

    rosterAiAbortRef.current?.abort()
    const ac = new AbortController()
    rosterAiAbortRef.current = ac

    setRosterAiLoading(true)
    try {
      const existing = uniqueNames([
        ...normalizeRoster(rosterTextRef.current).map((r) => r.name),
        ...rosterVoiceNewNamesRef.current,
      ])
      const names = await geminiExtractRosterNamesWithExclusions({
        apiKey: key,
        model,
        inputText: text,
        existingNames: existing,
        signal: ac.signal,
      })
      if (!names.length) return

      setRosterVoiceNewNames((prev) => uniqueNames([...prev, ...names]))
      if (rosterVoiceAutoApplyRef.current) {
        setRosterText((prev) =>
          rosterItemsToText(
            uniqueRosterItems([...normalizeRoster(prev), ...names.map((n) => ({ studentId: '', name: n }))]),
          ),
        )
      }
      setRosterVoiceStatus(
        `已新增 ${names.length} 人（本次累计 ${uniqueNames([...rosterVoiceNewNamesRef.current, ...names]).length} 人）。`,
      )
    } catch (e) {
      if (isAbortError(e)) return
      setRosterVoiceStatus((e as Error).message || 'Gemini 提取失败。')
    } finally {
      setRosterAiLoading(false)
    }
  }, [])

  // Schedule AI extraction while speech is changing (debounced)
  useEffect(() => {
    if (!rosterVoiceOn) return
    const text = rosterVoiceLiveText
    if (!text) return
    if (rosterAiTimerRef.current) window.clearTimeout(rosterAiTimerRef.current)
    rosterAiTimerRef.current = window.setTimeout(() => {
      void runRosterAiExtractNow(rosterVoiceFinal.trim() || text)
    }, 3500)
  }, [rosterVoiceOn, rosterVoiceLiveText, rosterVoiceFinal, runRosterAiExtractNow])

  const startRosterVoice = () => {
    setRosterVoiceStatus('')
    if (!supported) {
      setRosterVoiceStatus('当前浏览器不支持 Web Speech API（建议使用 Chrome）。')
      return
    }
    if (isRecording) {
      setRosterVoiceStatus('当前正在进行“成绩录音”，请先结束后再录入花名册。')
      return
    }
    const rec = ensureRosterRecognition()
    if (!rec) {
      setRosterVoiceStatus('初始化语音识别失败。')
      return
    }
    rosterVoiceSnapshotRef.current = rosterText
    setRosterVoiceFinal('')
    setRosterVoiceInterim('')
    setRosterVoiceNewNames([])
    rosterAiLastHashRef.current = ''
    setRosterVoiceOn(true)
    try {
      rec.start()
    } catch {
      setRosterVoiceOn(false)
      setRosterVoiceStatus('启动识别失败：请稍后再试（或刷新页面）。')
    }
  }

  const stopRosterVoice = async () => {
    setRosterVoiceStatus('')
    rosterRecognitionRef.current?.stop()
    setRosterVoiceOn(false)
    if (rosterAiTimerRef.current) window.clearTimeout(rosterAiTimerRef.current)
    // flush one last extraction with final transcript
    if (rosterVoiceFinal.trim()) await runRosterAiExtractNow(rosterVoiceFinal.trim())
  }

  const undoRosterVoice = () => {
    setRosterText(rosterVoiceSnapshotRef.current)
    setRosterVoiceStatus('已撤销本次花名册语音录入。')
    setRosterVoiceNewNames([])
  }

  const stopAndSave = async () => {
    setStatus('')
    setGeminiMatchStatus('')
    recognitionRef.current?.stop()
    setIsRecording(false)

    const transcript = (finalText + ' ' + interimText).trim()
    if (!transcript) return

    const key = geminiApiKey.trim()
    const canUseGemini = Boolean(useGeminiForMatching && key && geminiModel && roster.length > 0)

    if (canUseGemini) {
      geminiAbortRef.current?.abort()
      const ac = new AbortController()
      geminiAbortRef.current = ac
      setGeminiMatchLoading(true)
      try {
        const pairs = await geminiParseHomeworkScores({
          apiKey: key,
          model: geminiModel,
          transcript,
          roster,
          signal: ac.signal,
        })
        setEntries((prev) => {
          const map = new Map<string, Entry>()
          for (const e of prev) {
            const key0 = e.studentId ? `id:${e.studentId.trim()}` : `name:${e.name.trim()}`
            map.set(key0, e)
          }
          for (const p of pairs) {
            const key0 = p.studentId ? `id:${p.studentId}` : `name:${p.name}`
            const existing = map.get(key0)
            if (existing) {
              map.set(key0, { ...existing, studentId: p.studentId, name: p.name, score: p.score })
            } else {
              map.set(key0, { id: uid(), studentId: p.studentId, name: p.name, score: p.score })
            }
          }
          return Array.from(map.values())
        })
        setGeminiMatchStatus(pairs.length ? `Gemini 已匹配并写入 ${pairs.length} 条记录。` : 'Gemini 未匹配到可确认的姓名-成绩（请检查花名册或转写文本）。')
      } catch (e) {
        if (isAbortError(e)) setGeminiMatchStatus('已取消 Gemini 匹配请求。')
        else {
          const msg = (e as Error).message || 'Gemini 匹配失败。'
          setGeminiMatchStatus(
            msg.includes('models/') && msg.includes('not found')
              ? `${msg}（请点击“刷新模型列表”，选择当前 Key 支持的模型）`
              : msg,
          )
        }
        // Fallback to local parsing (no fuzzy mapping)
        setEntries((prev) => {
          const map = new Map<string, Entry>()
          for (const e0 of prev) {
            const key0 = e0.studentId ? `id:${e0.studentId.trim()}` : `name:${e0.name.trim()}`
            map.set(key0, e0)
          }
          for (const p of parsedLive) {
            const key0 = p.studentId ? `id:${p.studentId}` : `name:${p.name.trim()}`
            if (!key0 || key0 === 'name:') continue
            const existing = map.get(key0)
            if (existing) {
              map.set(key0, { ...existing, studentId: p.studentId, name: p.name, score: p.score })
            } else {
              map.set(key0, { id: uid(), studentId: p.studentId, name: p.name, score: p.score })
            }
          }
          return Array.from(map.values())
        })
      } finally {
        setGeminiMatchLoading(false)
      }
      return
    }

    // Local fallback: merge parsed results into editable table (no aggressive fuzzy matching)
    setEntries((prev) => {
      const map = new Map<string, Entry>()
      for (const e of prev) {
        const key0 = e.studentId ? `id:${e.studentId.trim()}` : `name:${e.name.trim()}`
        map.set(key0, e)
      }
      for (const p of parsedLive) {
        const key0 = p.studentId ? `id:${p.studentId}` : `name:${p.name.trim()}`
        if (!key0 || key0 === 'name:') continue
        const existing = map.get(key0)
        if (existing) {
          map.set(key0, { ...existing, studentId: p.studentId, name: p.name, score: p.score })
        } else {
          map.set(key0, { id: uid(), studentId: p.studentId, name: p.name, score: p.score })
        }
      }
      return Array.from(map.values())
    })
  }

  const clearAll = () => {
    recognitionRef.current?.abort()
    setIsRecording(false)
    setStatus('')
    setFinalText('')
    setInterimText('')
    setEntries([])
  }

  const addEmptyRow = () => setEntries((prev) => [...prev, { id: uid(), studentId: '', name: '', score: '' }])

  const exportNow = () => exportToExcel({ date, homeworkTitle, entries })

  const runGeminiRoster = async () => {
    setGeminiStatus('')
    setGeminiPreview([])

    const key = geminiApiKey.trim()
    if (!key) {
      setGeminiStatus('请先填写 Gemini API Key（或配置 VITE_GEMINI_API_KEY）。')
      return
    }
    if (!geminiInputText.trim()) {
      setGeminiStatus('请粘贴原始名单/文本后再生成。')
      return
    }

    geminiAbortRef.current?.abort()
    const ac = new AbortController()
    geminiAbortRef.current = ac

    setGeminiLoading(true)
    try {
      const names = await geminiExtractRosterNames({
        apiKey: key,
        model: geminiModel,
        inputText: geminiInputText,
        signal: ac.signal,
      })
      setGeminiPreview(names)
      setGeminiStatus(names.length ? `已提取 ${names.length} 个姓名，可应用到花名册。` : '未提取到姓名：请检查输入文本或换一种粘贴格式。')
    } catch (e) {
      if (isAbortError(e)) {
        setGeminiStatus('已取消请求。')
      } else {
        const msg = (e as Error).message || 'Gemini 请求失败。'
        setGeminiStatus(
          msg.includes('models/') && msg.includes('not found')
            ? `${msg}（请点击“刷新模型列表”，选择当前 Key 支持的模型）`
            : msg,
        )
      }
    } finally {
      setGeminiLoading(false)
    }
  }

  const cancelGemini = () => {
    geminiAbortRef.current?.abort()
    geminiAbortRef.current = null
  }

  const applyGeminiRoster = () => {
    if (geminiPreview.length === 0) {
      setGeminiStatus('预览为空：请先生成。')
      return
    }
    const current = normalizeRoster(rosterText)
    const incoming = geminiPreview.map((name) => ({ studentId: '', name }))
    const next =
      geminiMode === 'replace'
        ? uniqueRosterItems(incoming)
        : uniqueRosterItems([...current, ...incoming])
    setRosterText(rosterItemsToText(next))
    setGeminiStatus(`已${geminiMode === 'replace' ? '替换' : '追加'}到花名册：当前 ${next.length} 人。`)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">语文作业成绩语音录入系统</div>
        <div className="header-subtitle">
          点击开始后直接念“姓名 成绩”，结束后可人工修正并导出 Excel
        </div>
      </header>

      <main className="main">
        <section className="panel">
          <div className="panel-title">控制区</div>

          <div className="controls">
            <button
              className="btn btn-primary"
              onClick={start}
              disabled={isRecording}
              title={!supported ? '当前浏览器不支持 Web Speech API' : undefined}
            >
              开始录音
            </button>
            <button className="btn" onClick={stopAndSave} disabled={(!isRecording && !liveText) || geminiMatchLoading}>
              结束 / 保存到登记表
            </button>
            <button className="btn btn-danger" onClick={clearAll} disabled={!finalText && !interimText && entries.length === 0}>
              清空
            </button>

            <div className="pill" aria-live="polite">
              {isRecording ? '录音中…' : '未录音'}
            </div>
          </div>

          <div className="meta">
            <label className="field">
              <div className="field-label">日期</div>
              <input
                className="input"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="field">
              <div className="field-label">作业名称（可选）</div>
              <input
                className="input"
                value={homeworkTitle}
                onChange={(e) => setHomeworkTitle(e.target.value)}
                placeholder="例如：第3课课后练习"
              />
            </label>
          </div>

          {!supported ? (
            <div className="hint danger">
              当前浏览器可能不支持 Web Speech API。建议使用桌面版 Chrome（并允许麦克风权限）。
            </div>
          ) : (
            <div className="hint">
              建议念法：<span className="mono">张三 95，李四 88</span>；支持中文数字如 <span className="mono">王五 九十五分</span>。
            </div>
          )}

          {status ? <div className="hint danger">{status}</div> : null}
          {geminiMatchStatus ? (
            <div className={`hint ${geminiMatchStatus.includes('失败') ? 'danger' : ''}`}>{geminiMatchStatus}</div>
          ) : null}

          <label className="check">
            <input
              type="checkbox"
              checked={useGeminiForMatching}
              onChange={(e) => setUseGeminiForMatching(e.target.checked)}
              disabled={!geminiApiKey.trim()}
            />
            <span>
              结束保存时用 Gemini 基于花名册（学号/姓名）做匹配（更准确，需填写 API Key）
              {geminiMatchLoading ? '（匹配中…）' : ''}
            </span>
          </label>
        </section>

        <section className="panel">
          <div className="panel-title">花名册（用于精准匹配姓名）</div>
          <div className="panel-subtitle">每行一个姓名，会自动保存到浏览器本地。</div>
          <textarea
            className="textarea"
            value={rosterText}
            onChange={(e) => setRosterText(e.target.value)}
            rows={7}
            placeholder="每行一个学生：学号(可选) + 姓名，例如：\n202401\t张三\n202402 李四\n王五"
          />
          <div className="tiny">当前花名册人数：{roster.length}</div>

          <div className="divider" />
          <div className="panel-title">AI 实时语音录入花名册</div>
          <div className="panel-subtitle">
            点击开始后直接念学生姓名（可带序号/停顿/重复），系统会实时转写并由 Gemini 提取姓名，自动追加到花名册。
          </div>

          <div className="controls">
            <button className="btn btn-primary" onClick={startRosterVoice} disabled={rosterVoiceOn || !supported}>
              开始语音录入花名册
            </button>
            <button className="btn" onClick={() => void stopRosterVoice()} disabled={!rosterVoiceOn}>
              结束
            </button>
            <button className="btn btn-danger" onClick={undoRosterVoice} disabled={!rosterVoiceSnapshotRef.current}>
              撤销本次录入
            </button>
            <div className="pill" aria-live="polite">
              {rosterVoiceOn ? '录入中…' : '未录入'}
            </div>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={rosterVoiceAutoApply}
              onChange={(e) => setRosterVoiceAutoApply(e.target.checked)}
            />
            <span>实时写入花名册（自动追加去重）{rosterAiLoading ? '（AI 处理中…）' : ''}</span>
          </label>

          {rosterVoiceStatus ? (
            <div className={`hint ${rosterVoiceStatus.includes('失败') || rosterVoiceStatus.includes('错误') ? 'danger' : ''}`}>
              {rosterVoiceStatus}
            </div>
          ) : null}

          <div className="grid2">
            <section className="panel inset">
              <div className="panel-title">实时转写（花名册）</div>
              <div className="transcript">
                <div className="transcript-final">{rosterVoiceFinal || '（等待识别结果…）'}</div>
                {rosterVoiceInterim ? <div className="transcript-interim">{rosterVoiceInterim}</div> : null}
              </div>
            </section>
            <section className="panel inset">
              <div className="panel-title">本次新增姓名（AI 提取）</div>
              {rosterVoiceNewNames.length === 0 ? (
                <div className="empty">（尚未提取到姓名）</div>
              ) : (
                <div className="chips">
                  {rosterVoiceNewNames.map((n) => (
                    <span className="chip" key={n}>
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="divider" />
          <div className="panel-title">Gemini 辅助录入花名册（可选）</div>
          <div className="panel-subtitle">
            把原始名单（可含序号/备注/混杂文字）粘贴到下方，Gemini 会尝试提取姓名并生成预览。注意：在纯前端调用会暴露 API Key，建议使用受限 Key 或改为后端代理。
          </div>

          <div className="ai-grid">
            <label className="field">
              <div className="field-label">Gemini API Key</div>
              <input
                className="input"
                type="password"
                value={geminiApiKey}
                onChange={(e) => setGeminiApiKey(e.target.value)}
                placeholder="粘贴你的 API Key（或使用 VITE_GEMINI_API_KEY）"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <div className="field-label">模型</div>
              <select
                className="input select"
                value={geminiModelChoice}
                onChange={(e) => setGeminiModelChoice(e.target.value)}
                aria-label="Gemini 模型选择"
              >
                <optgroup label="常用预设（可手动选择）">
                  <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                  <option value="gemini-1.5-flash-latest">gemini-1.5-flash-latest</option>
                  <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                  <option value="gemini-2.0-flash-lite">gemini-2.0-flash-lite</option>
                </optgroup>
                {geminiModels.length ? (
                  <optgroup label="当前 Key 可用模型（generateContent）">
                    {geminiModels.map((m) => (
                      <option key={m.name} value={geminiModelDisplayName(m.name)}>
                        {geminiModelDisplayName(m.name)}
                        {m.displayName ? `（${m.displayName}）` : ''}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <option value={GEMINI_CUSTOM_MODEL}>自定义…</option>
              </select>
            </label>
          </div>

          <div className="ai-actions">
            <button className="btn" onClick={() => void refreshGeminiModels()} disabled={geminiModelsLoading || !geminiApiKey.trim()}>
              {geminiModelsLoading ? '刷新中…' : '刷新模型列表'}
            </button>
            {geminiModelsStatus ? <div className="tiny">{geminiModelsStatus}</div> : null}
          </div>

          {geminiModelChoice === GEMINI_CUSTOM_MODEL ? (
            <label className="field">
              <div className="field-label">自定义模型名称</div>
              <input
                className="input"
                value={geminiModelCustom}
                onChange={(e) => setGeminiModelCustom(e.target.value)}
                placeholder="例如：gemini-2.0-flash 或 models/gemini-2.0-flash"
              />
            </label>
          ) : null}

          <label className="check">
            <input
              type="checkbox"
              checked={rememberGeminiKey}
              onChange={(e) => setRememberGeminiKey(e.target.checked)}
            />
            <span>记住 API Key（保存到浏览器 localStorage）</span>
          </label>

          <textarea
            className="textarea"
            value={geminiInputText}
            onChange={(e) => setGeminiInputText(e.target.value)}
            rows={5}
            placeholder="粘贴原始名单/文本，例如：\n1. 张三（语文）\n2. 李四\n3. 王五"
          />

          <div className="ai-actions">
            <select
              className="input select"
              value={geminiMode}
              onChange={(e) => setGeminiMode(e.target.value as GeminiRosterMode)}
              aria-label="应用方式"
            >
              <option value="append">追加去重</option>
              <option value="replace">替换花名册</option>
            </select>

            <button className="btn btn-primary" onClick={runGeminiRoster} disabled={geminiLoading}>
              {geminiLoading ? '生成中…' : '生成预览'}
            </button>
            <button className="btn" onClick={applyGeminiRoster} disabled={geminiLoading || geminiPreview.length === 0}>
              应用到花名册
            </button>
            <button className="btn btn-danger" onClick={cancelGemini} disabled={!geminiLoading}>
              取消
            </button>
          </div>

          {geminiStatus ? <div className={`hint ${geminiStatus.includes('失败') ? 'danger' : ''}`}>{geminiStatus}</div> : null}

          {geminiPreview.length ? (
            <div className="preview roster-preview">
              {geminiPreview.map((n) => (
                <div key={n} className="preview-row">
                  <div className="preview-name">{n}</div>
                  <div className="preview-score">{/* spacer */}</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="grid2">
          <section className="panel">
            <div className="panel-title">实时显示区：原始文本</div>
            <div className="panel-subtitle">包含实时转写（临时结果会不断变化）。</div>
            <div className="transcript">
              <div className="transcript-final">{finalText || '（等待识别结果…）'}</div>
              {interimText ? <div className="transcript-interim">{interimText}</div> : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">实时解析预览（只读）</div>
            <div className="panel-subtitle">结束后点“保存到登记表”即可进入可编辑状态。</div>
            {parsedLive.length === 0 ? (
              <div className="empty">（尚未解析到“姓名/学号-成绩”）</div>
            ) : (
              <div className="preview">
                {parsedLive.map((p) => (
                  <div key={`${p.studentId || p.name}_${p.score}`} className="preview-row">
                    <div className="preview-name">
                      {p.studentId ? `${p.studentId} ` : ''}
                      {p.name}
                      <span className={`tag tag-${p.matchType}`}>
                        {p.matchType === 'exact'
                          ? '花名册匹配'
                          : '未匹配'}
                      </span>
                    </div>
                    <div className="preview-score">{p.score}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>

        <section className="panel">
          <div className="panel-title">结构化数据：今日登记表（可编辑）</div>
          <div className="panel-subtitle">
            可直接修改学号/姓名/成绩；学号或姓名输入框支持花名册联想（姓名重名时建议用学号）。
          </div>

          <div className="table-actions">
            <button className="btn" onClick={addEmptyRow}>
              + 添加一行
            </button>
            <button className="btn btn-primary" onClick={exportNow} disabled={entries.length === 0}>
              导出 Excel
            </button>
          </div>

          <datalist id="rosterNames">
            {rosterNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <datalist id="rosterIds">
            {rosterIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>

          {entries.length === 0 ? (
            <div className="empty">（登记表为空：先录音并保存，或手动添加一行）</div>
          ) : (
            <div className="table">
              <div className="table-head">
                <div>学号</div>
                <div>姓名</div>
                <div>成绩（0-100）</div>
                <div />
              </div>
              {entries.map((row) => (
                <div className="table-row" key={row.id}>
                  <input
                    className="input"
                    list="rosterIds"
                    value={row.studentId}
                    onChange={(e) => {
                      const nextId = normalizeStudentId(e.target.value)
                      const matched = nextId ? rosterById.get(nextId) : undefined
                      setEntries((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? {
                                ...r,
                                studentId: nextId,
                                name: matched ? matched.name : r.name,
                              }
                            : r,
                        ),
                      )
                    }}
                    placeholder="例如：202401"
                  />
                  <input
                    className="input"
                    list="rosterNames"
                    value={row.name}
                    onChange={(e) =>
                      setEntries((prev) => {
                        const nextName = normalizeStudentName(e.target.value)
                        const count = rosterNameCounts.get(nextName) ?? 0
                        const matched =
                          nextName && count === 1 ? roster.find((x) => x.name === nextName) : undefined
                        return prev.map((r) =>
                          r.id === row.id
                            ? {
                                ...r,
                                name: e.target.value,
                                studentId: matched ? matched.studentId : r.studentId,
                              }
                            : r,
                        )
                      })
                    }
                    placeholder="例如：张三"
                  />
                  <input
                    className="input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    value={row.score}
                    onChange={(e) => {
                      const v = e.target.value
                      const n = v === '' ? '' : clampScore(Number(v)) ?? ''
                      setEntries((prev) =>
                        prev.map((r) => (r.id === row.id ? { ...r, score: n } : r)),
                      )
                    }}
                    placeholder="例如：95"
                  />
                  <button
                    className="btn btn-ghost"
                    onClick={() => setEntries((prev) => prev.filter((r) => r.id !== row.id))}
                    aria-label="删除此行"
                    title="删除此行"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <div className="tiny">
          说明：本页面使用浏览器 Web Speech API（常见于 Chrome）进行语音转写；结束保存时可用 Gemini 基于花名册（学号/姓名）做匹配，从而降低误识别；你可以在导出前手动修正登记表内容。
        </div>
      </footer>
    </div>
  )
}

export default App
