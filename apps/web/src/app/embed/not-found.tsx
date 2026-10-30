import { connection } from 'next/server';
import { headers } from 'next/headers';

export default async function EmbedNotFound() {
  await connection();
  await headers();

  return (
    <html lang="vi" className="dark">
      <body className="bg-black m-0 p-0 overflow-hidden w-screen h-screen">
        <div className="flex h-screen w-screen items-center justify-center bg-black text-white text-sm">
          Video không tồn tại hoặc không ở chế độ công khai.
        </div>
      </body>
    </html>
  );
}
