import { Navigate, RouterProvider, createBrowserRouter } from 'react-router'

import { AppShell } from '@/components/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppProvider } from '@/lib/app-context'
import { ProjectPage } from '@/pages/project-page'
import { ProjectsPage } from '@/pages/projects-page'
import { SettingsPage } from '@/pages/settings-page'

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/projects" replace /> },
    ],
  },
])

export default function App() {
  return (
    <AppProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </AppProvider>
  )
}
