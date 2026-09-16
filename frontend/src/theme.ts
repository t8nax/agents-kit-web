import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const themeKey = 'agents-kit-web.theme'

function chosen(): Theme | null {
  const value = localStorage.getItem(themeKey)
  return value === 'light' || value === 'dark' ? value : null
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

// Пока выбора не было, тему держит CSS по системной; выбранная приходит атрибутом
function apply(theme: Theme | null) {
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

export function applyChosenTheme() {
  apply(chosen())
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => chosen() ?? systemTheme())

  // Без своего выбора панель следует за системой и тогда, когда та сменилась при открытой вкладке
  useEffect(() => {
    if (chosen()) return
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!media) return
    const onChange = () => {
      if (!chosen()) setTheme(systemTheme())
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem(themeKey, next)
      apply(next)
      return next
    })
  }, [])

  return { theme, toggle }
}
