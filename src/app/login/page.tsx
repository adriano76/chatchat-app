// Caminho: src/app/login/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function AuthPage() {
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  
  // Estado para detetar o ambiente
  const [isMobileApp, setIsMobileApp] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Deteção super agressiva do Capacitor no Android/iOS
      const cap = (window as any).Capacitor;
      const isNative = cap && (cap.isNativePlatform?.() || cap.isNative);
      
      if (isNative) {
        setIsMobileApp(true);
      }

      // 2. Injeta a Ponte Nativa (Bridge) do Capacitor para agarrar o login
      import('@capacitor/app').then(({ App }) => {
        App.addListener('appUrlOpen', (event) => {
          // Quando o Google devolve o link chatchat://login-callback#access_token=...
          if (event.url.includes('#access_token=')) {
            const hash = event.url.substring(event.url.indexOf('#'));
            window.location.hash = hash; 
            
            setMessage({ type: 'success', text: 'Sessão autorizada! A iniciar ChatChat...' });
            
            setTimeout(() => {
              router.push('/');
              router.refresh();
            }, 1000);
          }
        });
      }).catch(() => {
        // Ignora erros na Web
      });
    }
  }, [router]);

  // Função blindada que decide qual URL enviar para o Supabase
  const getRedirectUrl = () => {
    if (typeof window !== 'undefined') {
      const cap = (window as any).Capacitor;
      const isNativeNow = cap && (cap.isNativePlatform?.() || cap.isNative);
      
      // Se detetar nativamente OU a checkbox estiver marcada, força a abertura da App!
      if (isNativeNow || isMobileApp) {
        return 'chatchat://login-callback';
      }
    }
    return 'https://chatchat-app-tau.vercel.app/';
  };

  // --- FUNÇÃO: LOGIN COM GOOGLE ---
  async function handleGoogleLogin() {
    setMessage(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: getRedirectUrl(),
      }
    });
    
    if (error) {
      setMessage({ type: 'error', text: 'Erro ao ligar ao Google: ' + error.message });
    }
  }

  // --- FUNÇÃO: LOGIN COM FACEBOOK ---
  async function handleFacebookLogin() {
    setMessage(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'facebook',
      options: {
        redirectTo: getRedirectUrl(),
      }
    });
    
    if (error) {
      setMessage({ type: 'error', text: 'Erro ao ligar ao Facebook: ' + error.message });
    }
  }

  // --- FUNÇÃO TRADICIONAL (EMAIL E SENHA) ---
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    // Limpa espaços invisíveis e forca minúsculas
    const cleanEmail = email.trim().toLowerCase();

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            data: {
              username: username.trim().toLowerCase(),
              full_name: username.trim(),
            },
          },
        });
        if (error) throw error;
        setMessage({ type: 'success', text: 'Cadastro realizado com sucesso! Você já pode entrar.' });
        setIsSignUp(false);
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (error) throw error;
        router.push('/');
        router.refresh();
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Erro na autenticação.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 p-8 rounded-2xl shadow-xl">
        <div className="text-center mb-6">
          <Link href="/" className="text-2xl font-bold text-emerald-500 hover:text-emerald-400 transition">
            ChatChat
          </Link>
          <h2 className="text-xl font-bold mt-2">
            {isSignUp ? 'Criar sua conta' : 'Entrar no ChatChat'}
          </h2>
          <p className="text-xs text-neutral-400 mt-1">
            {isSignUp
              ? 'Cadastre-se para se conectar de forma rápida e segura.'
              : 'Entre para conversar com a sua rede de contactos.'}
          </p>
        </div>

        {message && (
          <div
            className={`p-3 rounded-lg text-xs mb-4 border ${
              message.type === 'error'
                ? 'bg-rose-950/50 border-rose-800 text-rose-300'
                : 'bg-emerald-950/50 border-emerald-800 text-emerald-300'
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="space-y-3 mb-6">
          <button
            onClick={handleGoogleLogin}
            type="button"
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 hover:bg-neutral-800 transition text-sm font-bold text-neutral-200"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continuar com o Google
          </button>
          
          <button
            onClick={handleFacebookLogin}
            type="button"
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-lg border border-neutral-700 bg-neutral-950 hover:bg-neutral-800 transition text-sm font-bold text-neutral-200"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.675 0h-21.35C.597 0 0 .597 0 1.325v21.351C0 23.403.597 24 1.325 24H12.82v-9.294H9.692v-3.622h3.128V8.413c0-3.1 1.893-4.788 4.659-4.788 1.325 0 2.463.099 2.795.143v3.24l-1.918.001c-1.504 0-1.795.715-1.795 1.763v2.313h3.587l-.467 3.622h-3.12V24h6.116c.73 0 1.323-.597 1.323-1.325V1.325C24 .597 23.403 0 22.675 0z" fill="#1877F2"/>
            </svg>
            Continuar com Facebook
          </button>
        </div>

        <div className="flex items-center gap-4 mb-6">
          <div className="h-px bg-neutral-800 flex-1"></div>
          <span className="text-xs text-neutral-500 font-bold uppercase tracking-widest">ou</span>
          <div className="h-px bg-neutral-800 flex-1"></div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Nome de Usuário</label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ex: adriano_ms"
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1">E-mail</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1">Senha</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 pr-10 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-neutral-950 font-bold text-sm transition disabled:opacity-50 mt-2"
          >
            {loading ? 'Aguarde...' : isSignUp ? 'Cadastrar Conta' : 'Entrar'}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-neutral-400">
          {isSignUp ? (
            <p>Já possui uma conta? <button type="button" onClick={() => { setIsSignUp(false); setMessage(null); }} className="text-emerald-400 hover:underline font-semibold">Entrar</button></p>
          ) : (
            <p>Não tem uma conta? <button type="button" onClick={() => { setIsSignUp(true); setMessage(null); }} className="text-emerald-400 hover:underline font-semibold">Cadastre-se gratuitamente</button></p>
          )}
        </div>

        {/* OVERRIDE MANUAL: Garante o redirecionamento nativo caso a deteção falhe */}
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-neutral-500 bg-neutral-950/40 py-2.5 rounded-lg border border-neutral-800">
          <input 
            type="checkbox" 
            id="forceApp" 
            checked={isMobileApp} 
            onChange={(e) => setIsMobileApp(e.target.checked)} 
            className="accent-emerald-500 w-4 h-4 cursor-pointer"
          />
          <label htmlFor="forceApp" className="cursor-pointer font-medium hover:text-neutral-300 transition">
            Modo App Nativa (Ative para forçar retorno do Google)
          </label>
        </div>

      </div>
    </main>
  );
}