import { useEffect, useRef, useState } from 'react'
import TrackerProjects from './TrackerProjects'
import TrackerServersCard, { type TrackerServer } from './TrackerServersCard'
import './Settings.css'

type TrackersProps = {
  /** Окно трекера этой базы открывается само — возврат к просьбе о трекере из шапки панели. */
  trackerFor?: { base: string; at: number } | null
  /** Выбрать проект этой базы — переход из строки «Бэклога» о поломке трекера; servers — о ключе: показать серверы. */
  trackersAt?: { base: string; at: number; servers: boolean } | null
}

/**
 * Раздел «Трекеры» (B-323): слева проекты, справа трекер выбранного, ниже серверы трекеров с ключами.
 * Список серверов читает карточка серверов, а подробности проекта по нему называют ключ к серверу проекта.
 */
export default function Trackers({ trackerFor = null, trackersAt = null }: TrackersProps) {
  const [servers, setServers] = useState<TrackerServer[] | null>(null)
  const serversCard = useRef<HTMLDivElement>(null)
  const toServers = trackersAt?.servers ? trackersAt.at : null
  // Переход из строки о ключе: на экране — список серверов, где ключ добавляют и меняют.
  useEffect(() => {
    if (toServers !== null && servers !== null) serversCard.current?.scrollIntoView?.({ block: 'start' })
  }, [toServers, servers])
  return (
    <div className="settings">
      <div className="content-head">
        <h2>Трекеры</h2>
      </div>
      <TrackerProjects
        key={trackerFor?.at ?? trackersAt?.at ?? 'trackers'}
        rewriteFor={trackerFor}
        focus={trackersAt?.servers ? null : trackersAt}
        selected={trackersAt?.base ?? null}
        servers={servers}
      />
      <div ref={serversCard}>
        <TrackerServersCard onServers={setServers} />
      </div>
    </div>
  )
}
