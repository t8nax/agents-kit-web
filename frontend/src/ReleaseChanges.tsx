/** Строки выпуска подряд: фразы оператору, у сборок до фраз — заголовки задач тем же видом (макет B-313). */
export default function ReleaseChanges({ changes }: { changes: string[] }) {
  return (
    <ul>
      {changes.map((change, index) => (
        <li key={index}>{change}</li>
      ))}
    </ul>
  )
}
