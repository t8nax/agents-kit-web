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

/**
 * Раздел «Трекеры» (B-323): слева проекты, справа трекер выбранного. Ключи к серверам вводятся в окне трекера проекта,
 * отдельного списка серверов нет (ответ оператора на B-285): раздел читает только владельцев ключей — их называет
 * строка ключа в подробностях проекта и подсказка поля ключа в окне.
 */
export default function Trackers({ trackerFor = null, trackersAt = null }: TrackersProps) {
  const [servers, setServers] = useState<TrackerServer[] | null>(null)
  const loadServers = useCallback(() => {
    fetch('/api/trackers')
      .then((response) => (response.ok ? (response.json() as Promise<TrackerServer[]>) : Promise.reject()))
      .then(setServers, () => setServers(null))
  }, [])
  useEffect(loadServers, [loadServers])
  return (
    <div className="settings">
      <div className="content-head">
        <h2>Трекеры</h2>
      </div>
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
