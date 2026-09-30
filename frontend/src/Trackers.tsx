import { useState } from 'react'
import TrackerProjects from './TrackerProjects'
import TrackerServersCard, { type TrackerServer } from './TrackerServersCard'
import './Settings.css'

type TrackersProps = {
  /** Окно трекера этой базы открывается само — возврат к просьбе о трекере из шапки панели. */
  trackerFor?: { base: string; at: number } | null
  /** Выбрать проект этой базы — переход из строки «Бэклога» о поломке описания трекера. */
  trackersAt?: { base: string; at: number } | null
}

/**
 * Раздел «Трекеры» (B-323): слева проекты, справа трекер выбранного, ниже серверы трекеров с ключами.
 * Список серверов читает карточка серверов, а подробности проекта по нему называют ключ к серверу проекта.
 */
export default function Trackers({ trackerFor = null, trackersAt = null }: TrackersProps) {
  const [servers, setServers] = useState<TrackerServer[] | null>(null)
  return (
    <div className="settings">
      <div className="content-head">
        <h2>Трекеры</h2>
      </div>
      <TrackerProjects key={trackerFor?.at ?? 'trackers'} rewriteFor={trackerFor} focus={trackersAt} servers={servers} />
      <TrackerServersCard onServers={setServers} />
    </div>
  )
}
