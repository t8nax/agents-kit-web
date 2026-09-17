import { useCallback, useState } from 'react'

const collapsedKey = 'agents-kit-web.collapsed-groups'

// Группа — база; свёрнутые помнит браузер. Хранилище может быть недоступно — тогда всё развёрнуто.
function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function write(bases: string[]) {
  try {
    localStorage.setItem(collapsedKey, JSON.stringify(bases))
  } catch {
    // выбор проживёт до перезагрузки
  }
}

export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<string[]>(read)

  const toggle = useCallback((base: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(base) ? prev.filter((item) => item !== base) : [...prev, base]
      write(next)
      return next
    })
  }, [])

  return { isCollapsed: (base: string) => collapsed.includes(base), toggle }
}
