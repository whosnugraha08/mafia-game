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
    const prompt = `Buatkan narasi pembuka game untuk ${playerCount} pemain.
Ceritakan suasana desa kecil yang terisolir, di mana seseorang menyimpan niat gelap.
Para penduduk (pemain) harus bersatu mencari pengkhianat sebelum semuanya terlambat.
Akhiri dengan kalimat yang meminta semua "pemain" untuk bersiap.`;
    return this._call(prompt, 300);
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
