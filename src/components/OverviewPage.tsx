import { useAuth } from "../hooks/useAuth";
import { AuthLoadingScreen, LoginScreen } from "./AuthScreens";
import { Overview } from "./Overview";

export function OverviewPage() {
  const { authLoading, user, logout } = useAuth();

  if (authLoading) return <AuthLoadingScreen />;
  if (!user) return <LoginScreen />;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">WAREHOUSE · RECEIVING</div>
          <h1>未完成看板</h1>
          <p>缺交供应商 / 未提交单子一览</p>
        </div>

        <div className="operator">
          <div className="operator-name">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" />
            ) : (
              <span className="operator-avatar">👤</span>
            )}
            <span>{user.name}</span>
          </div>
          <button type="button" onClick={logout}>退出</button>
        </div>
      </header>

      <a className="back-link" href="/">← 返回收货填报</a>

      <Overview
        onSelectDate={(date) => {
          window.location.href = `/?date=${encodeURIComponent(date)}`;
        }}
      />
    </main>
  );
}
