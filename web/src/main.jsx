import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { applyTheme, loadTheme } from './theme.js'
import { applyLang, loadLang } from './i18n.js'
import './index.css'

// Antes do primeiro render: o tema, senão o board pisca claro antes de virar
// escuro; o idioma, porque t() é lida durante o render.
applyTheme(loadTheme())
applyLang(loadLang())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
