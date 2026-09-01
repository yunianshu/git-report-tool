<template>
  <div ref="el" :style="{ width: '100%', height }"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '280px' },
})

const el = ref(null)
let chart = null
let ro = null

function render() {
  if (!el.value) return
  if (!chart) chart = echarts.init(el.value)
  chart.setOption(props.option, true)
}

function resize() {
  chart && chart.resize()
}

onMounted(() => {
  // 容器尺寸变化即同步 canvas：统计分析 tab 激活时（display:none → 可见）容器
  // 宽度变化，仅监听 window resize 无法感知，导致图表被压缩成初始 100px 宽。
  if (typeof ResizeObserver !== 'undefined' && el.value) {
    ro = new ResizeObserver(resize)
    ro.observe(el.value)
  }
  window.addEventListener('resize', resize)
  nextTick(render)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  if (ro) {
    ro.disconnect()
    ro = null
  }
  if (chart) {
    chart.dispose()
    chart = null
  }
})

watch(() => props.option, render, { deep: true })
</script>
