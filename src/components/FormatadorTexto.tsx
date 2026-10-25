import React from 'react';

export default function FormatadorTexto({ texto }: { texto: string }) {
  // 1. PREVENÇÃO DE ERRO:
  if (!texto) return null;

  // ---------------------------------------------------------------------------
  // REGEX DE URL (O Detetive de Links):
  // ---------------------------------------------------------------------------
  const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
  
  // 2. FATIAMENTO DO TEXTO:
  const partes = texto.split(urlRegex);

  return (
    <div className="whitespace-pre-wrap text-neutral-300 text-sm break-words">
      
      {partes.map((parte, index) => {
        
        // A) VERIFICA SE O PEDAÇO ATUAL É UM LINK
        if (parte.match(urlRegex)) {
          const urlLower = parte.toLowerCase();

          // ===================================================================
          // 1. É UMA IMAGEM? (.jpg, .jpeg, .png, .gif, .webp, .img)
          // ===================================================================
          if (urlLower.match(/\.(jpeg|jpg|gif|png|webp|img)(\?.*)?$/) != null) {
            return (
              <img 
                key={index} 
                src={parte} 
                alt="Imagem compartilhada" 
                className="max-w-full max-h-[400px] object-cover rounded-lg my-3 border border-neutral-800 shadow-md" 
                loading="lazy"
              />
            );
          }

          // ===================================================================
          // 2. É UM VÍDEO DIRETO? (.mp4, .webm, .ogg)
          // ===================================================================
          if (urlLower.match(/\.(mp4|webm|ogg)(\?.*)?$/) != null) {
            return (
              <video 
                key={index} 
                controls 
                className="max-w-full max-h-[400px] rounded-lg my-3 border border-neutral-800 shadow-md bg-black"
              >
                <source src={parte} />
                O seu navegador não suporta a reprodução deste vídeo.
              </video>
            );
          }

          // ===================================================================
          // 3. REGEX DO YOUTUBE:
          // ===================================================================
          const youtubeRegex = /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
          const ytMatch = parte.match(youtubeRegex);

          if (ytMatch && ytMatch[1]) {
            const videoId = ytMatch[1];
            
            return (
              <div key={index} className="my-4 relative w-full pt-[56.25%] rounded-lg overflow-hidden border border-neutral-800 bg-neutral-950 shadow-md">
                <iframe
                  className="absolute top-0 left-0 w-full h-full"
                  src={`https://www.youtube.com/embed/${videoId}`}
                  title="Player de vídeo do YouTube"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                ></iframe>
              </div>
            );
          }

          // ===================================================================
          // 4. NOVO: É UM VÍDEO DO FACEBOOK? (Reels, Watch, Videos)
          // ===================================================================
          if (urlLower.includes('facebook.com') && (urlLower.includes('/reel/') || urlLower.includes('/videos/') || urlLower.includes('watch'))) {
            // Utilizamos a API oficial do Facebook para criar o iFrame seguro
            const fbEmbedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(parte)}&show_text=false&width=500`;
            
            return (
              <div key={index} className="my-4 flex justify-center w-full rounded-lg overflow-hidden border border-neutral-800 bg-neutral-950 shadow-md">
                <iframe 
                  src={fbEmbedUrl} 
                  className="w-full h-[500px] sm:h-[650px] border-0 overflow-hidden bg-black" 
                  scrolling="no" 
                  allowFullScreen={true} 
                  allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                  title="Vídeo do Facebook"
                ></iframe>
              </div>
            );
          }

          // ===================================================================
          // 5. É UM LINK NORMAL (Não é vídeo reconhecido, nem imagem)
          // ===================================================================
          return (
            <a 
              key={index} 
              href={parte} 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-emerald-500 hover:text-emerald-400 hover:underline break-all font-medium transition"
            >
              {parte}
            </a>
          );
        }

        // D) É APENAS TEXTO NORMAL
        return <span key={index}>{parte}</span>;
      })}
    </div>
  );
}