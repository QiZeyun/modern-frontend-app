import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import * as XLSX from 'xlsx'

type MatchType = 'exact' | 'fuzzy' | 'raw'

type ParsedPair = {
  name: string
  rawName: string
  score: number
  matchType: MatchType
  confidence: number
  source: string
}

type Entry = {
  id: string
  name: string
  score: number | ''
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

function normalizeRoster(text: string) {
  return text
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean)
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

function levenshtein(a: string, b: string) {
  const aa = Array.from(a)
  const bb = Array.from(b)
  const n = aa.length
  const m = bb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  )
  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[n][m]
}

function bestNameMatch(rawName: string, roster: string[]) {
  const cleaned = rawName.replace(/\s+/g, '').replace(/同学|同學/g, '')
  if (!cleaned) {
    return { name: rawName, matchType: 'raw' as const, confidence: 0 }
  }
  if (roster.includes(cleaned)) {
    return { name: cleaned, matchType: 'exact' as const, confidence: 1 }
  }
  let best = { name: cleaned, confidence: 0 }
  for (const candidate of roster) {
    const dist = levenshtein(cleaned, candidate)
    const denom = Math.max(Array.from(cleaned).length, Array.from(candidate).length, 1)
    const sim = 1 - dist / denom
    if (sim > best.confidence) best = { name: candidate, confidence: sim }
  }
  // Conservative threshold: avoid wrong matches in noisy speech
  if (best.confidence >= 0.6) {
    return { name: best.name, matchType: 'fuzzy' as const, confidence: best.confidence }
  }
  return { name: cleaned, matchType: 'raw' as const, confidence: best.confidence }
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

function parsePairsFromText(text: string, roster: string[]): ParsedPair[] {
  const normalized = normalizeTranscript(text)
  if (!normalized) return []

  const results: ParsedPair[] = []
  // e.g. "张三 95" / "李四九十五分" / "王五 得 88"
  const re =
    /([\u4e00-\u9fa5]{2,8})\s*(?:得|是|为)?\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*(?:分)?/g
  for (const match of normalized.matchAll(re)) {
    const rawName = (match[1] ?? '').trim()
    const rawScore = (match[2] ?? '').trim()
    const num = chineseToNumber(rawScore)
    if (num === null) continue
    const score = clampScore(num)
    if (score === null) continue

    const matched = bestNameMatch(rawName, roster)
    results.push({
      name: matched.name,
      rawName,
      score,
      matchType: matched.matchType,
      confidence: matched.confidence,
      source: match[0] ?? '',
    })
  }

  // De-duplicate by name, keep the latest occurrence (teachers often re-read corrections)
  const byName = new Map<string, ParsedPair>()
  for (const item of results) byName.set(item.name, item)
  return Array.from(byName.values())
}

function exportToExcel(params: {
  date: string
  homeworkTitle: string
  entries: Entry[]
}) {
  const { date, homeworkTitle, entries } = params
  const clean = entries
    .filter((e) => e.name.trim() && e.score !== '')
    .map((e) => ({ name: e.name.trim(), score: Number(e.score) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  const aoa: (string | number)[][] = [
    ['语文作业成绩登记表'],
    ['日期', date, '作业', homeworkTitle || '（未填写）'],
    [],
    ['姓名', '成绩'],
    ...clean.map((r) => [r.name, r.score]),
  ]

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 24 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '登记表')

  const filename = `语文作业成绩_${date}.xlsx`
  XLSX.writeFile(wb, filename)
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
    return () => {
      recognitionRef.current?.abort()
      recognitionRef.current = null
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

  const stopAndSave = () => {
    setStatus('')
    recognitionRef.current?.stop()
    setIsRecording(false)

    // Merge parsed results into editable table by name
    setEntries((prev) => {
      const map = new Map<string, Entry>()
      for (const e of prev) map.set(e.name.trim(), e)
      for (const p of parsedLive) {
        const key = p.name.trim()
        if (!key) continue
        const existing = map.get(key)
        if (existing) map.set(key, { ...existing, score: p.score })
        else map.set(key, { id: uid(), name: key, score: p.score })
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

  const addEmptyRow = () => setEntries((prev) => [...prev, { id: uid(), name: '', score: '' }])

  const exportNow = () => exportToExcel({ date, homeworkTitle, entries })

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
            <button className="btn" onClick={stopAndSave} disabled={!isRecording && parsedLive.length === 0}>
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
        </section>

        <section className="panel">
          <div className="panel-title">花名册（用于精准匹配姓名）</div>
          <div className="panel-subtitle">每行一个姓名，会自动保存到浏览器本地。</div>
          <textarea
            className="textarea"
            value={rosterText}
            onChange={(e) => setRosterText(e.target.value)}
            rows={7}
            placeholder="每行一个姓名，例如：\n张三\n李四\n王五"
          />
          <div className="tiny">当前花名册人数：{roster.length}</div>
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
              <div className="empty">（尚未解析到“姓名-成绩”）</div>
            ) : (
              <div className="preview">
                {parsedLive.map((p) => (
                  <div key={`${p.name}_${p.score}`} className="preview-row">
                    <div className="preview-name">
                      {p.name}
                      <span className={`tag tag-${p.matchType}`}>
                        {p.matchType === 'exact'
                          ? '花名册匹配'
                          : p.matchType === 'fuzzy'
                            ? `模糊匹配 ${(p.confidence * 100).toFixed(0)}%`
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
            可直接修改姓名/成绩；姓名输入框支持花名册联想。
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
            {roster.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>

          {entries.length === 0 ? (
            <div className="empty">（登记表为空：先录音并保存，或手动添加一行）</div>
          ) : (
            <div className="table">
              <div className="table-head">
                <div>姓名</div>
                <div>成绩（0-100）</div>
                <div />
              </div>
              {entries.map((row) => (
                <div className="table-row" key={row.id}>
                  <input
                    className="input"
                    list="rosterNames"
                    value={row.name}
                    onChange={(e) =>
                      setEntries((prev) =>
                        prev.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)),
                      )
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
          说明：本页面使用浏览器 Web Speech API（常见于 Chrome）进行语音转写，并用花名册做模糊匹配与噪声过滤；你可以在导出前手动修正登记表内容。
        </div>
      </footer>
    </div>
  )
}

export default App
