import { useEffect, useRef, useState } from 'react'

/**
 * 共享一个 IntersectionObserver 实例，避免为每个元素创建 observer。
 * 元素进入视口（含 200px 预加载边距）后回调一次并取消监听。
 */
const callbacks = new WeakMap<Element, () => void>()
let sharedObserver: IntersectionObserver | null = null

function getObserver(): IntersectionObserver {
  if (sharedObserver) return sharedObserver
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const callback = callbacks.get(entry.target)
        if (!callback) continue
        callbacks.delete(entry.target)
        sharedObserver?.unobserve(entry.target)
        callback()
      }
    },
    { rootMargin: '200px 0px' }
  )
  return sharedObserver
}

/**
 * 元素首次进入视口后返回 inView=true（只触发一次）。
 */
export function useInViewOnce<T extends Element = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (inView) return
    const element = ref.current
    if (!element) return

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }

    const observer = getObserver()
    callbacks.set(element, () => setInView(true))
    observer.observe(element)

    return () => {
      callbacks.delete(element)
      observer.unobserve(element)
    }
  }, [inView])

  return { ref, inView }
}
