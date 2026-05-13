import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { TokenGate } from "./components/TokenGate.js";
import { TimeWindowProvider } from "./time-window.js";
import { Alerts } from "./pages/Alerts.js";
import { Channels } from "./pages/Channels.js";
import { ConversationDetail } from "./pages/ConversationDetail.js";
import { Conversations } from "./pages/Conversations.js";
import { Costs } from "./pages/Costs.js";
import { Insights } from "./pages/Insights.js";
import { Logs } from "./pages/Logs.js";
import { Models } from "./pages/Models.js";
import { Overview } from "./pages/Overview.js";
import { RunDetail } from "./pages/RunDetail.js";
import { Runs } from "./pages/Runs.js";
import { Sessions } from "./pages/Sessions.js";
import { Sources } from "./pages/Sources.js";
import { Tools } from "./pages/Tools.js";

export function App() {
  return (
    <TokenGate>
      <TimeWindowProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/models" element={<Models />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/conversations/:runId" element={<ConversationDetail />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </Layout>
      </TimeWindowProvider>
    </TokenGate>
  );
}
