import { AtpAgent } from '@atproto/api';

export class Poster {
  private constructor(private agent: AtpAgent) {}

  static async login(handle: string, appPassword: string): Promise<Poster> {
    const agent = new AtpAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password: appPassword });
    return new Poster(agent);
  }

  async post(text: string, image: Buffer | null, alt: string): Promise<string> {
    let embed;
    if (image) {
      const upload = await this.agent.uploadBlob(image, { encoding: 'image/png' });
      embed = { $type: 'app.bsky.embed.images' as const, images: [{ image: upload.data.blob, alt }] };
    }
    const res = await this.agent.post({ text, embed, createdAt: new Date().toISOString() });
    return res.uri;
  }
}
