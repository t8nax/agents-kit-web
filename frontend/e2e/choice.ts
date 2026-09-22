import { expect, type Locator } from '@playwright/test'

/** Цвет токена темы так, как его отдаёт getComputedStyle: токен в CSS записан hex, а стиль читается rgb. */
async function tokenColor(where: Locator, token: string) {
  return where.evaluate((element, name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    element.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
}

/** Строка выбора выглядит выбранной или нет — по макету B-212: залитый кружок с галочкой и полужирное имя. */
export async function expectChoice(row: Locator, on: boolean) {
  const mark = row.locator('.choice-mark')
  const name = row.locator('.choice-name')
  // Размер значка меряется здесь, а не в jsdom: общее `.modal-overlay svg` перебило бы правило той же силы
  await expect(mark).toHaveCSS('width', '16px')
  await expect(mark.locator('svg')).toHaveCSS('width', '10px')
  if (on) {
    await expect(mark).toHaveCSS('background-color', await tokenColor(row, '--text-primary'))
    await expect(mark.locator('svg')).toBeVisible()
    await expect(name).toHaveCSS('font-weight', '500')
  } else {
    await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(mark.locator('svg')).toBeHidden()
    await expect(name).toHaveCSS('font-weight', '400')
    // Под мышью кружок невыбранной строки темнеет
    await row.hover()
    await expect(mark).toHaveCSS('border-top-color', await tokenColor(row, '--text-secondary'))
  }
}

/** Рамка у строки выбора — только с клавиатуры: после щелчка мышью её нет, после перехода Tab есть. */
export async function expectRingOnlyFromKeyboard(row: Locator) {
  await row.click()
  const radio = row.getByRole('radio')
  await expect(radio).toBeFocused()
  await expect(row).toHaveCSS('outline-style', 'none')
  // Уйти назад и вернуться Tab: в группу radio Tab приводит на выбранный
  await radio.press('Shift+Tab')
  await row.page().keyboard.press('Tab')
  await expect(radio).toBeFocused()
  await expect(row).toHaveCSS('outline-style', 'solid')
}
