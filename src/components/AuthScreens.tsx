export function AuthLoadingScreen() {
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">📋</div>
        <h1>每日收货验收</h1>
        <p>正在检查登录状态……</p>
      </div>
    </main>
  );
}

export function LoginScreen() {
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">📋</div>
        <h1>每日收货验收</h1>
        <p>这是门店收货验收系统，请使用门店飞书账号登录。</p>
        <button
          className="login-button"
          type="button"
          onClick={() => {
            window.location.href = "/api/auth/login";
          }}
        >
          使用飞书登录
        </button>
        <div className="auth-note">
          登录后才能查看当天供应商、上传验收照片和提交收货记录。
        </div>
      </div>
    </main>
  );
}
