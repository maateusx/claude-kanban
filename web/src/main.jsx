import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { start as startTheme } from './theme.js'
import './index.css'

startTheme()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
