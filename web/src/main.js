import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initStore } from './store.js'

const boot = document.getElementById('boot')
const fail = (msg) => {
  if (boot) {
    boot.innerHTML =
      `<div class="boot-err"><b>连接后端失败</b><p>${msg}</p>` +
      `<p class="boot-hint">先启动服务端：<code>cd server &amp;&amp; npm start</code></p></div>`
  }
}

// 数据从后端拉取后再挂载，组件里就可以照旧同步读 store 的导出
initStore()
  .then(() => {
    boot?.remove()
    createApp(App).mount('#app')
  })
  .catch(e => fail(e?.message || String(e)))
