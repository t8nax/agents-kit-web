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
  const [projectsRead, setProjectsRead] = useState(false)
  // «Добавить» у недостающего ключа: адрес сервера проекта ложится в поле «Адрес сервера», курсор — в «Ключ».
  const [addKey, setAddKey] = useState<{ server: string; at: number } | null>(null)
  const serversCard = useRef<HTMLDivElement>(null)
  const scrolledAt = useRef<number | null>(null)
  const toServers = trackersAt?.servers ? trackersAt.at : null
  const serversRead = servers !== null
  // Переход из строки о ключе: на экране — список серверов, где ключ добавляют и меняют. Прокрутка — одна на переход
  // и после того, как прочитаны и проекты над списком, и сам список: правка ключа экран больше не дёргает (ревью B-323).
  useEffect(() => {
    if (toServers === null || scrolledAt.current === toServers || !projectsRead || !serversRead) return
    scrolledAt.current = toServers
    serversCard.current?.scrollIntoView?.({ block: 'start' })
  }, [toServers, projectsRead, serversRead])
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
        onRead={setProjectsRead}
        onAddKey={(server) => {
          setAddKey({ server, at: Date.now() })
          serversCard.current?.scrollIntoView?.({ block: 'start' })
        }}
      />
      <div ref={serversCard}>
        <TrackerServersCard onServers={setServers} prefill={addKey} />
      </div>
    </div>
  )
}
