// Caminho: src/components/LogoutButton.tsx
'use client';

import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      // Ajuste a rota '/login' para '/' se a sua página de entrada for a raiz
      router.push('/login'); 
    } catch (error) {
      console.error('Erro ao sair:', error);
      alert('Não foi possível terminar a sessão.');
    }
  };

  return (
    <button 
      onClick={handleLogout}
      className="p-2 text-rose-500 hover:bg-rose-50 hover:text-rose-600 rounded-full transition-all flex items-center justify-center shadow-sm border border-transparent hover:border-rose-100"
      title="Sair da aplicação"
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
      </svg>
    </button>
  );
}
