declare module 'staticmaps' {
  interface StaticMapsOptions {
    width: number;
    height: number;
    tileUrl?: string;
    tileRequestHeader?: Record<string, string>;
  }
  interface CircleOptions {
    coord: [number, number];
    radius: number;
    color?: string;
    fill?: string;
    width?: number;
  }
  export default class StaticMaps {
    constructor(options: StaticMapsOptions);
    image: { buffer(mime: string): Promise<Buffer> };
    addCircle(circle: CircleOptions): void;
    render(center?: [number, number], zoom?: number): Promise<void>;
  }
}
