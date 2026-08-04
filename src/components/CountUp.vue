<template>
  <span>{{ display }}</span>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  target: { type: Number, default: 0 },
  duration: { type: Number, default: 800 },
})

const display = ref(0)
let raf = null

function animate(to) {
  cancelAnimationFrame(raf)
  const from = display.value
  if (to === from) return
  const start = performance.now()
  const step = (t) => {
    const p = Math.min(1, (t - start) / props.duration)
    const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
    display.value = Math.round(from + (to - from) * eased)
    if (p < 1) raf = requestAnimationFrame(step)
    else display.value = to
  }
  raf = requestAnimationFrame(step)
}

watch(() => props.target, animate, { immediate: true })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>
