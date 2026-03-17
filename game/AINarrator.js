'use strict';

const OpenAI = require('openai');

const SYSTEM_PROMPT = `Kamu adalah Narator misterius untuk game deduksi sosial bertema gelap di sebuah desa terpencil.
Gunakan bahasa Indonesia yang dramatis, puitis, dan menegangkan.
Ceritamu pendek, padat, dan penuh atmosfer. Maksimal 3 paragraf singkat.
Jangan pernah menyebut nama mekanik game seperti "senjata", "jejak", "kartu", atau "ronde".
Sisipkan clue secara tersirat dan puitis, bukan langsung.`;

class AINarrator {
  constructor() {
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY belum di-set di environment variables.');
      }
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  async _call(userPrompt, maxTokens = 350) {
    const response = await this._getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: maxTokens,
      temperature: 0.85,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ]
    });
    return response.choices[0].message.content.trim();
  }

  async generateIntro(playerCount) {
    const prompt = `Kamu adalah narator misterius untuk game deduksi sosial dengan ${playerCount} pemain. Buat narasi pembuka yang SEKALIGUS berfungsi sebagai panduan game lengkap — dikemas seluruhnya dalam bahasa dramatis, puitis, dan mencekam. Bahasa Indonesia. Jangan gunakan bullet point atau daftar — narasikan segalanya seperti seorang dalang yang menuturkan takdir.

STRUKTUR (tanpa header, semua jadi prosa mengalir, pisah dengan baris kosong):

PARAGRAF 1-2 — KISAH PEMBUKA: Gambarkan desa kecil terpencil di malam kelam. Seseorang di antara warga menyimpan niat berdarah. Para warga harus menemukan pengkhianat sebelum semuanya hancur.

PARAGRAF 3 — PERAN SANG IMPOSTOR: Ceritakan secara dramatis bahwa satu jiwa gelap di antara kalian adalah Sang Impostor — ia bangun di malam hari, memilih satu korban beserta senjata dan jejak yang akan ditinggalkannya. Di ronde pertama, ia bisa memilih merekrut seseorang menjadi sekutunya daripada membunuh. Impostor menang bila bertahan tiga ronde, atau bila hanya tersisa dua orang hidup.

PARAGRAF 4 — PERAN SANG PELINDUNG: Satu jiwa lain dipilih takdir sebagai Pelindung — ia bangun setelah impostor tidur kembali, dan memilih satu orang untuk diselamatkan malam itu. Ia boleh melindungi dirinya sendiri.

PARAGRAF 5 — PERAN PARA DETEKTIF: Sisanya adalah warga biasa, para Detektif — mereka tidak bangun malam. Senjata mereka adalah kecerdasan dan diskusi. Setiap detektif hanya punya satu kesempatan menuduh sepanjang game. Tuduhan harus menyebut nama tersangka, satu kartu senjata, dan satu kartu jejak yang diyakini digunakan. Jika tuduhan salah, sang detektif langsung tereliminasi.

PARAGRAF 6 — SISTEM KARTU & CLUE: Setiap pemain memegang enam kartu (tiga senjata dan tiga jejak), semuanya terbuka untuk dilihat semua orang. Clue tersembunyi ada di narasi pagi hari — narator akan bercerita secara tersirat, dan dari sanalah para detektif harus menyimpulkan.

PARAGRAF 7 — ALUR PERMAINAN: Narasikan alur: Malam tiba → Impostor beraksi → Pelindung berjaga → Pagi datang → Narator menuturkan kejadian dengan clue tersembunyi → Siang → Diskusi dan tuduhan → Bila tak ada yang benar, malam kembali datang. Ini bisa terjadi hingga tiga ronde.

PARAGRAF 8 — SERUAN PENUTUP: Satu kalimat dramatis yang menyerukan semua pemain untuk bersiap. Game dimulai.

Total: maksimal 8 paragraf singkat-sedang. Buat setiap kata terasa berat dan penuh misteri.`;
    return this._call(prompt, 1000);
  }

  async generateMorningNarrative({ outcome, targetName, weapon, trace, round }) {
    let prompt = '';

    if (outcome === 'killed') {
      prompt = `Ronde ${round}. Pagi hari. Seseorang bernama "${targetName}" ditemukan tewas.
Pelaku menggunakan "${weapon}" sebagai alat, dan meninggalkan "${trace}" di tempat kejadian.
WAJIB: Sisipkan deskripsi puitis tentang "${weapon}" dan "${trace}" secara tidak langsung dalam narasimu.
Misal: jika senjatanya "Tali Rami", ceritakan tentang tanda melingkar di leher. Jika jejaknya "Jejak Kaki", ceritakan tapak kaki yang basah.
Jangan sebut nama benda secara literal. Buat detektif berpikir keras. 3 paragraf.`;

    } else if (outcome === 'recruited') {
      prompt = `Ronde ${round}. Pagi hari yang aneh. "${targetName}" masih hidup, tapi sesuatu berubah dari matanya.
Semalam ada pertemuan gelap: pelaku datang dengan "${weapon}" sebagai ancaman, dan "${trace}" tertinggal sebagai tanda perjanjian.
WAJIB: Sisipkan deskripsi puitis tentang "${weapon}" dan "${trace}" secara implisit.
"${targetName}" hidup, namun kini menyimpan rahasia. 3 paragraf.`;

    } else if (outcome === 'blocked') {
      prompt = `Ronde ${round}. Pagi hari penuh ketegangan. Ada yang mencoba beraksi semalam, tapi gagal karena seseorang berjaga.
Pelaku datang membawa "${weapon}", meninggalkan "${trace}", namun pergi dengan tangan kosong.
WAJIB: Sisipkan deskripsi tentang "${weapon}" dan "${trace}" secara tersirat meski aksi gagal.
Tidak ada korban, tapi buktinya tetap ada. 3 paragraf.`;

    } else {
      prompt = `Ronde ${round}. Pagi hari yang sunyi. Tidak ada peristiwa besar semalam.
Namun ketegangan semakin memuncak — sesuatu terasa mengintai di balik ketenangan ini.
Tulis narasi pendek (2 paragraf) tentang suasana mencekam yang diam-diam membara.`;
    }

    return this._call(prompt, 400);
  }
}

// Fallback narratives jika OpenAI gagal
AINarrator.getFallback = function (outcome, targetName, weapon, trace) {
  if (outcome === 'killed') {
    return `Fajar menyingsing di atas desa yang masih diselimuti kabut. Namun ketenangan itu segera pecah ketika seseorang menemukan ${targetName} sudah tidak bernyawa. Bukti-bukti samar tertinggal di tempat kejadian perkara.\n\nBayang-bayang pelaku masih terasa di udara pagi yang dingin. Siapakah yang menyimpan rahasia gelap ini di antara kalian?`;
  } else if (outcome === 'recruited') {
    return `Pagi ini, ${targetName} terlihat berbeda. Matanya menyimpan sesuatu yang tidak bisa diungkapkan. Semalam, sebuah pertemuan rahasia berlangsung di balik kegelapan.\n\nApa yang terjadi? Hanya ${targetName} yang tahu. Dan kini ia memilih untuk diam.`;
  } else if (outcome === 'blocked') {
    return `Pagi yang penuh tanda tanya. Seseorang mencoba bergerak semalam, namun gagal karena ada yang berjaga. Jejak-jejak samar tertinggal sebagai bukti percobaan yang tak berhasil.\n\nPelaku mundur, namun ia tidak menyerah. Waspadalah.`;
  }
  return `Fajar tiba dengan membawa keheningan yang mencekam. Tidak ada korban malam ini, namun ketegangan terus memuncak.\n\nPengkhianat masih bersembunyi di antara kalian. Siang ini adalah waktumu untuk bertindak.`;
};

module.exports = AINarrator;
