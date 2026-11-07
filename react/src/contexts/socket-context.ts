import { SocketIOManager } from '@/lib/socket'
import { createContext, useContext } from 'react'

export interface SocketContextType {
  connected: boolean
  socketId?: string
  connecting: boolean
  error?: string
  socketManager: SocketIOManager | null
}

export const SocketContext = createContext<SocketContextType>({
  connected: false,
  connecting: false,
  socketManager: null,
})

export const useSocket = () => useContext(SocketContext)
