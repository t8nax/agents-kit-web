import { useCallback, useState } from 'react'

const collapsedKey = 'agents-kit-web.collapsed-groups'

// Свёрнутые группы помнит браузер, у каждого раздела свои. Хранилище может быть недоступно — тогда всё развёрнуто.
function read(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function write(key: string, groups: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(groups))
  } catch {
    // выбор проживёт до перезагрузки
  }
}

export function useCollapsedGroups(key: string = collapsedKey) {
  const [collapsed, setCollapsed] = useState<string[]>(() => read(key))

  const toggle = useCallback(
    (group: string) => {
      setCollapsed((prev) => {
        const next = prev.includes(group) ? prev.filter((item) => item !== group) : [...prev, group]
        write(key, next)
        return next
      })
    },
    [key],
  )

  return { isCollapsed: (group: string) => collapsed.includes(group), toggle }
}
