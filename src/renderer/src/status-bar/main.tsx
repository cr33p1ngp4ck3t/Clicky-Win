import React from 'react'
import ReactDOM from 'react-dom/client'
import { StatusBar } from './StatusBar'
import '../shared/design-system.css'
import './status-bar.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <StatusBar />
  </React.StrictMode>
)
