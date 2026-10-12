import { createContext, useContext, type ReactNode } from "react";
import { AuthProvider, useAuth } from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";
import { setTokenGetter } from "./api";

/** 배포 시 CDK 가 S3 에 쓰는 /config.json. 없으면(로컬 dev) 인증 없이 동작 */
export type AppConfig = {
  region?: string; userPoolId?: string; clientId?: string; cognitoAuthority?: string; cognitoDomain?: string; redirectUri?: string;
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch("/config.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return {};
    return (await r.json()) as AppConfig;
  } catch { return {}; }
}

export type AuthState = {
  enabled: boolean;
  status: "loading" | "anonymous" | "authenticated" | "error";
  error?: string;
  email?: string;
  accessToken?: string;
  signin: () => void;
  signout: () => void;
};
const Ctx = createContext<AuthState>({ enabled: false, status: "authenticated", signin: () => {}, signout: () => {} });
export const useAppAuth = () => useContext(Ctx);

export function AuthGate({ config, children }: { config: AppConfig; children: ReactNode }) {
  if (!config.cognitoAuthority || !config.clientId) return <>{children}</>;
  const redirect = config.redirectUri ?? window.location.origin + "/";
  return (
    <AuthProvider
      authority={config.cognitoAuthority}
      client_id={config.clientId}
      redirect_uri={redirect}
      post_logout_redirect_uri={redirect}
      response_type="code"
      scope="openid email profile"
      automaticSilentRenew
      userStore={new WebStorageStateStore({ store: window.localStorage })}
      onSigninCallback={() => window.history.replaceState({}, document.title, window.location.pathname)}>
      <CognitoBridge config={config}>{children}</CognitoBridge>
    </AuthProvider>
  );
}

function CognitoBridge({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  // 자식(App)의 effect 가 부모 effect 보다 먼저 실행되므로 렌더 중에 즉시 등록한다
  setTokenGetter(() => auth.user?.id_token);
  const state: AuthState = {
    enabled: true,
    status: auth.isLoading ? "loading" : auth.error ? "error" : auth.isAuthenticated ? "authenticated" : "anonymous",
    error: auth.error?.message,
    email: auth.user?.profile.email,
    accessToken: auth.user?.access_token,
    signin: () => auth.signinRedirect(),
    signout: () => {
      auth.removeUser();
      const redirect = encodeURIComponent(config.redirectUri ?? window.location.origin + "/");
      window.location.href = `${config.cognitoDomain}/logout?client_id=${config.clientId}&logout_uri=${redirect}`;
    },
  };
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
