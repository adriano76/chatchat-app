// Caminho: src/lib/supabase.ts
// Motivo: Inicialização única do cliente Supabase para ser reutilizado em todo o motor P2P e base de dados.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);