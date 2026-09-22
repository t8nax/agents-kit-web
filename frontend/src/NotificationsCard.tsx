import { useNotifications } from './notifications'
import './NotificationsCard.css'

/** Карточка «Уведомления» в «Настройках»: включает и выключает системные уведомления о смене статуса копий. */
export default function NotificationsCard() {
  const { permission, muted, request, setEnabled } = useNotifications()

  return (
    <section className="settings-card" aria-labelledby="settings-notifications">
      <div className="settings-card-head">
        <div>
          <h3 id="settings-notifications">Уведомления</h3>
          <p className="settings-lead">Сообщения браузера, когда копия меняет статус.</p>
        </div>
      </div>
      <div className="bases-body">
        {permission === 'denied' ? (
          <p className="notify-off">Уведомления запрещены в браузере</p>
        ) : permission === 'unsupported' ? (
          <p className="notify-off">Этот браузер не поддерживает уведомления</p>
        ) : (
          <div className="notify-row">
            <span className="notify-label" id="notify-label">
              Показывать уведомления
            </span>
            {/* Пока браузер не разрешал, включение спрашивает у него разрешение */}
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={permission === 'granted' && !muted}
              aria-labelledby="notify-label"
              onClick={permission === 'granted' ? () => setEnabled(muted) : request}
            />
          </div>
        )}
      </div>
    </section>
  )
}
