import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/shell';
import { AuthProvider, RequireAdmin, RequireAuth, RequireOperator } from './lib/auth';
import { Login } from './pages/login';
import { SettingsRuntime } from './pages/settings-runtime';
import { ToastProvider } from './components/toast';
import { TooltipProvider } from './components/ui';
import { Overview } from './pages/overview';
import { Missions } from './pages/missions';
import { NewMission } from './pages/new-mission';
import { MissionDetail } from './pages/mission-detail';
import { MissionDag } from './pages/mission-dag';
import { MissionBoard } from './pages/mission-board';
import { MissionBlackboard } from './pages/mission-blackboard';
import { MissionExplore } from './pages/mission-explore';
import { MissionOverviewPage } from './pages/mission-overview';
import { MissionAssets } from './pages/mission-assets';
import { MissionTraces } from './pages/mission-traces';
import { Evals } from './pages/evals';
import { Trace } from './pages/trace';
import { Findings } from './pages/findings';
import { FindingDetail } from './pages/finding-detail';
import { Approvals } from './pages/approvals';
import { NotFound } from './pages/not-found';
import { SettingsModels } from './pages/settings-models';
import { SettingsAccount } from './pages/settings-account';
import { SettingsWatchdog } from './pages/settings-watchdog';

export function App() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <AuthProvider>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<RequireAuth><Shell /></RequireAuth>}>
            <Route index element={<Overview />} />
            <Route path="missions" element={<Missions />} />
            <Route path="missions/new" element={<RequireOperator><NewMission /></RequireOperator>} />
            <Route path="missions/:id" element={<MissionDetail />} />
            <Route path="missions/:id/dag" element={<MissionDag />} />
            <Route path="missions/:id/board" element={<MissionBoard />} />
            <Route path="missions/:id/blackboard" element={<MissionBlackboard />} />
            <Route path="missions/:id/explore" element={<MissionExplore />} />
            <Route path="missions/:id/overview" element={<MissionOverviewPage />} />
            <Route path="missions/:id/assets" element={<MissionAssets />} />
            <Route path="missions/:id/traces" element={<MissionTraces />} />
            <Route path="trace/:subjectType/:subjectId" element={<Trace />} />
            <Route path="findings" element={<Findings />} />
            <Route path="findings/:id" element={<FindingDetail />} />
            <Route path="metrics" element={<Navigate to="/?view=metrics" replace />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="settings/models" element={<RequireAdmin><SettingsModels /></RequireAdmin>} />
            <Route path="settings/runtime" element={<RequireAdmin><SettingsRuntime /></RequireAdmin>} />
            <Route path="settings/account" element={<RequireAdmin><SettingsAccount /></RequireAdmin>} />
            <Route path="settings/watchdog" element={<RequireAdmin><SettingsWatchdog /></RequireAdmin>} />
            <Route path="settings/evals" element={<RequireAdmin><Evals /></RequireAdmin>} />
            <Route path="evals" element={<Navigate to="/settings/evals" replace />} />
            <Route path="dashboard" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
        </AuthProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}
