import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared/design-system.css'
import './panel.css'
import { Panel } from './Panel'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>
)
