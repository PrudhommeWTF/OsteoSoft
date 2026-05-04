import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  EventEmitter,
  SimpleChanges,
  signal,
  computed,
  viewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';

type CanvasBg = 'adulte' | 'bb';

interface SchemaData {
  v: number;
  bg: CanvasBg;
  drawing: string;
}

const COLORS = [
  { value: '#000000', label: 'Noir' },
  { value: '#c30b0b', label: 'Rouge' },
  { value: '#0010a7', label: 'Bleu' },
  { value: '#029e3d', label: 'Vert' },
  { value: '#ed8806', label: 'Orange' },
  { value: '#8b3391', label: 'Violet' },
  { value: '#edf00b', label: 'Jaune' }
];

const BRUSH_SIZES = [
  { value: 1, dotSize: 6 },
  { value: 3, dotSize: 10 },
  { value: 5, dotSize: 14 }
];

const CANVAS_WIDTH = 845;
const CANVAS_HEIGHT = 450;
const MAX_HISTORY = 20;

function parseSchemaData(value: string): SchemaData | null {
  if (!value || !value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && parsed.v === 1 && typeof parsed.drawing === 'string') {
      return {
        v: 1,
        bg: parsed.bg === 'bb' ? 'bb' : 'adulte',
        drawing: parsed.drawing
      };
    }
  } catch {
    // ignore
  }
  return null;
}

@Component({
  selector: 'app-consultation-canvas',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './consultation-canvas.component.html',
  styleUrls: ['./consultation-canvas.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConsultationCanvasComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('drawingCanvas');

  readonly enabled = signal(false);
  readonly bg = signal<CanvasBg>('adulte');
  readonly selectedColor = signal('#c30b0b');
  readonly brushSize = signal(3);
  readonly erasing = signal(false);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  readonly bgSrc = computed(() => this.bg() === 'bb' ? 'squelette-bb.jpg' : 'squelette.jpg');

  readonly colors = COLORS;
  readonly brushSizes = BRUSH_SIZES;

  private ctx: CanvasRenderingContext2D | null = null;
  private painting = false;
  private started = false;
  private lastX = 0;
  private lastY = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private pendingLoad: string | null = null;
  private bgLoaded = false;

  readonly checkboxId = `schema-canvas-${Math.random().toString(36).slice(2)}`;

  ngAfterViewInit(): void {
    this.initCanvas();
    if (this.pendingLoad !== null) {
      this.loadDrawing(this.pendingLoad);
      this.pendingLoad = null;
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['value']) return;
    const parsed = parseSchemaData(this.value);
    if (parsed) {
      this.enabled.set(true);
      this.bg.set(parsed.bg);
      if (this.ctx) {
        this.loadDrawing(parsed.drawing);
      } else {
        this.pendingLoad = parsed.drawing;
      }
    } else {
      this.enabled.set(false);
    }
  }

  ngOnDestroy(): void {
    // nothing to clean up
  }

  toggleEnabled(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.enabled.set(checked);
    if (!checked) {
      this.valueChange.emit('');
    } else {
      this.clearCanvas(false);
      this.emitValue();
    }
  }

  setBg(bg: CanvasBg): void {
    this.bg.set(bg);
    this.emitValue();
  }

  setColor(color: string): void {
    this.selectedColor.set(color);
    this.erasing.set(false);
  }

  setBrushSize(size: number): void {
    this.brushSize.set(size);
  }

  toggleEraser(): void {
    this.erasing.set(!this.erasing());
  }

  clearCanvas(emitAfter = true): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!this.ctx || !canvas) return;
    this.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.pushHistory();
    if (emitAfter) this.emitValue();
  }

  undo(): void {
    if (!this.canUndo()) return;
    this.historyIndex--;
    this.restoreHistory();
    this.updateHistoryButtons();
    this.emitValue();
  }

  redo(): void {
    if (!this.canRedo()) return;
    this.historyIndex++;
    this.restoreHistory();
    this.updateHistoryButtons();
    this.emitValue();
  }

  onMouseDown(event: MouseEvent): void {
    this.painting = true;
    this.started = false;
    const { x, y } = this.getCanvasCoords(event.clientX, event.clientY);
    this.lastX = x;
    this.lastY = y;
    event.preventDefault();
  }

  onMouseMove(event: MouseEvent): void {
    if (!this.painting) return;
    const { x, y } = this.getCanvasCoords(event.clientX, event.clientY);
    this.drawTo(x, y);
    this.lastX = x;
    this.lastY = y;
  }

  onMouseUp(): void {
    if (!this.painting) return;
    this.painting = false;
    this.started = false;
    this.pushHistory();
    this.emitValue();
  }

  onTouchStart(event: TouchEvent): void {
    this.painting = true;
    this.started = false;
    const touch = event.touches[0];
    const { x, y } = this.getCanvasCoords(touch.clientX, touch.clientY);
    this.lastX = x;
    this.lastY = y;
    event.preventDefault();
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.painting) return;
    const touch = event.touches[0];
    const { x, y } = this.getCanvasCoords(touch.clientX, touch.clientY);
    this.drawTo(x, y);
    this.lastX = x;
    this.lastY = y;
    event.preventDefault();
  }

  private initCanvas(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) return;
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    // Push initial empty state to history
    this.history = [canvas.toDataURL('image/png')];
    this.historyIndex = 0;
    this.updateHistoryButtons();
  }

  private getCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  private drawTo(x: number, y: number): void {
    if (!this.ctx) return;
    if (!this.started) {
      this.ctx.beginPath();
      this.ctx.moveTo(this.lastX, this.lastY);
      this.started = true;
    }
    if (this.erasing()) {
      this.ctx.clearRect(x - 10, y - 10, 20, 20);
    } else {
      this.ctx.lineTo(x, y);
      this.ctx.strokeStyle = this.selectedColor();
      this.ctx.lineWidth = this.brushSize();
      this.ctx.stroke();
    }
  }

  private loadDrawing(dataUrl: string): void {
    if (!this.ctx || !dataUrl) return;
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    this.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (dataUrl === '' || dataUrl === 'data:,') {
      this.history = [canvas.toDataURL('image/png')];
      this.historyIndex = 0;
      this.updateHistoryButtons();
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.ctx!.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      this.ctx!.drawImage(img, 0, 0);
      const state = canvas.toDataURL('image/png');
      this.history = [state];
      this.historyIndex = 0;
      this.updateHistoryButtons();
    };
    img.src = dataUrl;
  }

  private pushHistory(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.ctx) return;
    const state = canvas.toDataURL('image/png');
    // Truncate forward history
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(state);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    } else {
      this.historyIndex++;
    }
    this.updateHistoryButtons();
  }

  private restoreHistory(): void {
    if (!this.ctx) return;
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const state = this.history[this.historyIndex];
    if (!state) return;
    const img = new Image();
    img.onload = () => {
      this.ctx!.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      this.ctx!.drawImage(img, 0, 0);
    };
    img.src = state;
  }

  private updateHistoryButtons(): void {
    this.canUndo.set(this.historyIndex > 0);
    this.canRedo.set(this.historyIndex < this.history.length - 1);
  }

  private emitValue(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.ctx) return;
    const drawing = canvas.toDataURL('image/png');
    const data: SchemaData = { v: 1, bg: this.bg(), drawing };
    this.valueChange.emit(JSON.stringify(data));
  }

  getCompositeDataUrl(): string {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.ctx) return '';
    const offscreen = document.createElement('canvas');
    offscreen.width = CANVAS_WIDTH;
    offscreen.height = CANVAS_HEIGHT;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return '';
    const bgImg = new Image();
    bgImg.src = this.bgSrc();
    if (bgImg.complete) {
      offCtx.drawImage(bgImg, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    offCtx.drawImage(canvas, 0, 0);
    return offscreen.toDataURL('image/jpeg', 0.85);
  }
}
