import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <header className="app-header">
        <h1>🚀 Modern Frontend App</h1>
        <p>基于 React + TypeScript + Vite 构建</p>
      </header>

      <main className="app-main">
        <div className="card">
          <h2>计数器示例</h2>
          <div className="counter">
            <button onClick={() => setCount((count) => count - 1)}>
              -
            </button>
            <span className="count">{count}</span>
            <button onClick={() => setCount((count) => count + 1)}>
              +
            </button>
          </div>
          <button 
            className="reset-btn" 
            onClick={() => setCount(0)}
          >
            重置
          </button>
        </div>

        <div className="card">
          <h2>功能特性</h2>
          <ul className="features">
            <li>✅ React 18 + TypeScript</li>
            <li>✅ Vite 构建工具</li>
            <li>✅ ESLint 代码检查</li>
            <li>✅ GitHub Actions CI/CD</li>
            <li>✅ 现代化 UI 设计</li>
          </ul>
        </div>
      </main>

      <footer className="app-footer">
        <p>每次 push 代码后，GitHub Actions 会自动触发构建 🎉</p>
      </footer>
    </div>
  )
}

export default App
