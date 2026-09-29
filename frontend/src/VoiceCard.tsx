import { useCallback, useEffect, useState } from 'react'
import { TrashIcon } from './DeleteWorkspaceModal'
import { Sk, Skeleton } from './Skeleton'
import { useReveal, withReveal } from './reveal'
import { useVoiceModule } from './voice'
import './PanelCard.css'
import './VoiceCard.css'

export type VoiceState = {
  state: 'absent' | 'downloading' | 'installed' | 'failed'
  downloaded: number
  total: number | null
  error: string | null
}

const pollMs = 1000

/** «212,4» — мегабайты, как в окне обновления панели. */
const megabytes = (bytes: number) =>
  (bytes / 1024 / 1024).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const progress = ({ downloaded, total }: VoiceState) =>
  total ? `${megabytes(downloaded)} из ${megabytes(total)} МБ` : `${megabytes(downloaded)} МБ`

/** Почему не скачалось и на чём прервалось; скачанное наполовину API уже убрал. */
function failure(voice: VoiceState) {
  const reason = (voice.error ?? 'Скачивание прервалось.').replace(/\.$/, '')
  if (voice.downloaded <= 0) return `${reason}. Голосовой ввод не установлен.`
  return `${reason} на ${progress(voice)}. Скачанное удалено, голосовой ввод не установлен.`
}

/**
 * Карточка «Голосовой ввод» в «Настройках»: модель распознавания — модуль по желанию (B-291). Скачивается
 * кнопкой, ход виден мегабайтами, пока идёт — карточка перечитывает его сама; поставленную убирают «Удалить».
 * Поставили или убрали — кнопки микрофона в окнах узнают об этом сразу.
 */
export default function VoiceCard() {
  const [voice, setVoice] = useState<VoiceState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reveal = useReveal(voice === null && !error)
  const { refresh } = useVoiceModule()

  const load = useCallback(
    () =>
      fetch('/api/voice')
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json() as Promise<VoiceState>
        })
        .then((loaded) => {
          setVoice(loaded)
          setError(null)
        })
        .catch(() => setError('Нет связи с API')),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  const downloading = voice?.state === 'downloading'
  useEffect(() => {
    if (!downloading) return
    const timer = setInterval(() => void load(), pollMs)
    return () => clearInterval(timer)
  }, [downloading, load])

  // Каждая смена состояния — и начало скачивания тоже — доходит до панели: увидев, что модель качается, панель
  // следит за ней сама, и кнопки в окнах зажигаются, даже если оператор ушёл из «Настроек» (ревью B-291).
  const state = voice?.state ?? null
  useEffect(() => {
    if (state) refresh()
  }, [state, refresh])

  const act = (method: string, url: string, failed: string) => {
    setBusy(true)
    setError(null)
    fetch(url, { method })
      .then((response) => {
        if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`)
        return load()
      })
      .catch(() => setError(failed))
      .finally(() => setBusy(false))
  }

  const install = () => act('POST', '/api/voice/install', 'Скачивание не запустилось')
  const cancel = () => act('POST', '/api/voice/cancel', 'Скачивание не отменилось')
  const remove = () => act('DELETE', '/api/voice', 'Модель не удалилась')

  return (
    <section className="settings-card" aria-labelledby="settings-voice">
      <div className="settings-card-head">
        <div>
          <h3 id="settings-voice">Голосовой ввод</h3>
          <p className="settings-lead">Диктовка в поля, где пишут агенту. Речь распознаётся на этом компьютере.</p>
        </div>
      </div>
      {!voice ? (
        error ? (
          <p className="bases-error">{error}</p>
        ) : (
          <Skeleton label="Загрузка сведений о голосовом вводе" shown={reveal.shown} className="panel-card-body">
            <div className="panel-row">
              <Sk w={60} h={10} />
              <Sk w="40%" h={10} />
              <Sk w={110} h={32} style={{ borderRadius: 6, marginLeft: 'auto' }} />
            </div>
          </Skeleton>
        )
      ) : (
        <div className={withReveal('panel-card-body', reveal)} onAnimationEnd={reveal.onAnimationEnd}>
          <div className="panel-row voice-row">
            <span className="panel-label">Модель</span>
            {voice.state === 'installed' ? (
              <>
                <span className="panel-current">Установлена</span>
                <span className="voice-size">{megabytes(voice.downloaded)} МБ</span>
                <span className="voice-end">
                  <button type="button" className="bases-btn bases-btn-danger" disabled={busy} onClick={remove}>
                    <TrashIcon />
                    Удалить
                  </button>
                </span>
              </>
            ) : voice.state === 'downloading' ? (
              <>
                <span className="voice-now">
                  <span className="voice-mark" aria-hidden="true" />
                  Скачивается
                </span>
                <span className="voice-size">{progress(voice)}</span>
                <span className="voice-end">
                  <button type="button" className="bases-btn" disabled={busy} onClick={cancel}>
                    Отменить
                  </button>
                </span>
              </>
            ) : (
              <>
                <span className="voice-value">не установлена</span>
                <span className="panel-hint">Whisper, около 600 МБ</span>
                {voice.state === 'absent' && (
                  <span className="voice-end">
                    <button type="button" className="bases-btn" disabled={busy} onClick={install}>
                      Установить
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
          {voice.state === 'failed' && (
            <div className="panel-failed" role="alert">
              <strong>Модель не скачалась</strong>
              <p>{failure(voice)}</p>
              <div className="panel-failed-actions">
                <button type="button" className="bases-btn" disabled={busy} onClick={install}>
                  Повторить
                </button>
              </div>
            </div>
          )}
          {error && <p className="bases-error">{error}</p>}
        </div>
      )}
    </section>
  )
}
