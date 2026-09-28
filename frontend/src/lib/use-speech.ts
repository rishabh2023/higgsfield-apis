import { useCallback, useEffect, useRef, useState } from 'react'

// Browser Web Speech API. In Chrome/Edge it is backed by Google's free speech service
// (no API key, no cost); Safari uses Apple's. Audio is processed by the browser vendor.
type SpeechRecognitionResultLike = { isFinal: boolean; 0: { transcript: string } }
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }
type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type Ctor = new () => SpeechRecognitionLike

function getCtor(): Ctor | null {
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const SPEECH_LANGS = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'pt-BR', label: 'Português' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'zh-CN', label: '中文' },
]

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the browser address bar and try again.',
  'service-not-allowed': 'Speech recognition is disabled in this browser.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs an internet connection.',
  'language-not-supported': 'That language is not supported by this browser.',
}

/**
 * Dictate into a text value. `start(base)` keeps `base` and appends what's spoken,
 * streaming interim words live via `onText`.
 */
export function useSpeech(onText: (text: string) => void, onError: (msg: string) => void) {
  const supported = typeof window !== 'undefined' && getCtor() !== null
  const [listening, setListening] = useState(false)
  const rec = useRef<SpeechRecognitionLike | null>(null)
  const cb = useRef({ onText, onError })
  cb.current = { onText, onError }

  const stop = useCallback(() => rec.current?.stop(), [])

  const start = useCallback((base: string, lang: string) => {
    const Ctor = getCtor()
    if (!Ctor) return
    rec.current?.abort()
    const r = new Ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    let finalText = ''
    const prefix = base && !/\s$/.test(base) ? `${base} ` : base
    r.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t.trim() + ' '
        else interim += t
      }
      cb.current.onText((prefix + finalText + interim).trimEnd())
    }
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') cb.current.onError(ERRORS[e.error] ?? `Speech error: ${e.error}`)
    }
    r.onend = () => setListening(false)
    rec.current = r
    try {
      r.start()
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [])

  useEffect(() => () => rec.current?.abort(), [])

  return { supported, listening, start, stop }
}
