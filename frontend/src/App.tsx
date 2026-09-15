import { useEffect, useState } from 'react'

type PingResponse = { status: string }

function App() {
  const [status, setStatus] = useState<string>('…')

  useEffect(() => {
    fetch('/api/ping')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<PingResponse>
      })
      .then((body) => setStatus(body.status))
      .catch(() => setStatus('нет связи с API'))
  }, [])

  return (
    <main>
      <h1>agents-kit-web</h1>
      <p>
        API: <span data-testid="ping-status">{status}</span>
      </p>
    </main>
  )
}

export default App
