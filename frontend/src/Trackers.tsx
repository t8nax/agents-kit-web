import { useCallback, useEffect, useState } from 'react'
import type { TrackerField } from './TrackerGroup'
import TrackerProjects, { type TrackerServer } from './TrackerProjects'
import './Settings.css'

type TrackersProps = {
  /** Окно трекера этой базы открывается само — возврат к просьбе о трекере из шапки панели. */
  trackerFor?: { base: string; at: number } | null
  /** Выбрать проект этой базы — переход из строки «Бэклога» о поломке трекера; field — открыть окно его трекера с курсором в этом поле. */
  trackersAt?: { base: string; at: number; field?: TrackerField } | null
}

/** Файл ключей к серверам трекеров не разобран: панель его не перезаписывает, поправить или удалить его — оператору. */
function brokenText(file: string | null | undefined): string {
  return `Файл ключей к серверам трекеров не разобран${file ? `: ${file}` : ''}. Поправьте или удалите его — после удаления ключи придётся ввести заново.`
}

/**
 * Раздел «Трекеры» (B-323): слева проекты, справа трекер выбранного. Ключи к серверам вводятся в окне трекера проекта,
 * отдельного списка серверов нет (ответ оператора на B-285): раздел читает только владельцев ключей — их называет
 * строка ключа в подробностях проекта и подсказка поля ключа в окне.
 */
export default function Trackers({ trackerFor = null, trackersAt = null }: TrackersProps) {
  const [servers, setServers] = useState<TrackerServer[] | null>(null)
  // Битый файл ключей — красной строкой с путём, а не молча: панель его не перезаписывает, поправить его — оператору
  // (ревью B-288, B-285)
  const [broken, setBroken] = useState<string | null>(null)
  const loadServers = useCallback(() => {
    fetch('/api/trackers')
      .then(async (response) => {
        if (response.ok) return response.json() as Promise<TrackerServer[]>
        const body = (await response.json().catch(() => null)) as { problem?: string; detail?: string | null } | null
        throw new Error(body?.problem === 'file-broken' ? brokenText(body.detail) : `Ключи к серверам трекеров не прочитаны: HTTP ${response.status}.`)
      })
      .then(
        (list) => {
          setServers(list)
          setBroken(null)
        },
        (e: unknown) => {
          setServers(null)
          setBroken(e instanceof TypeError ? null : String((e as Error).message))
        },
      )
  }, [])
  useEffect(loadServers, [loadServers])
  return (
    <div className="settings trackers">
      <div className="content-head">
        <h2>Трекеры</h2>
      </div>
      {broken && (
        <p className="bases-error tp-error" role="alert">
          {broken}
        </p>
      )}
      <TrackerProjects
        key={trackerFor?.at ?? trackersAt?.at ?? 'trackers'}
        rewriteFor={trackerFor}
        focus={trackersAt}
        selected={trackersAt?.base ?? null}
        servers={servers}
        // Записанное описание могло сохранить ключ или снять его вместе с последним трекером сервера
        onChanged={loadServers}
      />
    </div>
  )
}
