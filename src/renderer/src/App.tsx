import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { Settings } from './components/Settings'

export function App() {
  const init = useStore((s) => s.init)
  const settingsOpen = useStore((s) => s.settingsOpen)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <Chat />
      {settingsOpen && <Settings />}
    </div>
  )
}
