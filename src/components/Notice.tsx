import { useEffect } from 'react'
import { useStore } from '../store'

export function Notice() {
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice, setNotice])

  if (!notice) return null
  return (
    <div className="notice" role="status" onClick={() => setNotice(null)}>
      {notice}
    </div>
  )
}
