import TrackerProjectsCard from './TrackerProjectsCard'
import TrackerServersCard from './TrackerServersCard'
import './Settings.css'

type TrackersProps = {
  /** Окно трекера этой базы открывается само — возврат к просьбе о трекере из шапки панели. */
  trackerFor?: { base: string; at: number } | null
  /** Показать трекеры проектов — переход из строки «Бэклога» о поломке описания трекера. */
  trackersAt?: number | null
}

/** Раздел «Трекеры»: где у проектов задачи и ключи панели к серверам трекеров (B-323). */
export default function Trackers({ trackerFor = null, trackersAt = null }: TrackersProps) {
  return (
    <div className="settings">
      <div className="content-head">
        <h2>Трекеры</h2>
      </div>
      <TrackerProjectsCard key={trackerFor?.at ?? 'trackers'} rewriteFor={trackerFor} focusAt={trackersAt} />
      <TrackerServersCard />
    </div>
  )
}
