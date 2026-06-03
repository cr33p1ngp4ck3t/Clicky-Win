import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared/design-system.css'
import './overlay.css'
import { Overlay } from './Overlay'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
