// Fase 16 (U1): la mascotte. Geometrie, path, animazioni SMIL e classi CSS
// (.bot*, .hm-*, keyframes) sono quelli di Lovable, con le 5 famiglie scelte
// (h-creature, h-robo, h-device, jelly, pixel). Correzioni obbligatorie
// rispetto a Lovable: UN solo listener del puntatore (tracker condiviso in
// pointer.ts), movimento ridotto vero (niente <animate>, niente sguardo),
// pausa con finestra nascosta (bots-paused + pauseAnimations), accessibilità
// (role="img" + aria-label) e il sesto stato 'waiting' ("Aspetta te").
import { useEffect, useRef, useState } from 'react'
import { useLingui } from '@lingui/react'
import type { BotColor, BotFamily } from '../../../shared/types'
import { gazeFrom, subscribePointer } from './pointer'
import { onBotsVisibility, useReducedMotion } from './motion'
import { botAriaLabel, type BotState } from './bot-state'

export type { BotFamily, BotColor } from '../../../shared/types'

export interface BotProps {
  family: BotFamily
  /** il colore come TOKEN ('c3' → var(--bot-c3)): mai nomi CSS nel database */
  color: BotColor
  state: BotState
  size?: number
  /** la mascotte segue il puntatore (false nella sidebar e nelle card) */
  track?: boolean
  /** bot offline: spento e stato forzato a idle */
  dimmed?: boolean
  /** nome per l'aria-label ("Nanna, sta pensando"); assente = decorativa */
  label?: string
}

function Eyes({
  state,
  look,
  pos,
  shape = 'pill',
  ink = 'var(--bot-ink)'
}: {
  state: BotState
  look: { x: number; y: number }
  pos: [number, number][]
  shape?: 'pill' | 'dot' | 'square' | 'line'
  ink?: string
}) {
  // thinking: sguardo fisso in alto a destra; waiting: occhi fissi al centro,
  // verso chi guarda (come chi si sporge per chiedere)
  const off = state === 'thinking' ? { x: 3, y: -4 } : state === 'waiting' ? { x: 0, y: 0 } : look
  return (
    <g style={{ transform: `translate(${off.x}px, ${off.y}px)`, transition: 'transform .25s ease-out' }}>
      {pos.map(([cx, cy], i) => {
        if (state === 'happy') {
          return (
            <path
              key={i}
              d={`M${cx - 5} ${cy + 2} Q${cx} ${cy - 6} ${cx + 5} ${cy + 2}`}
              stroke={ink}
              strokeWidth={3.5}
              strokeLinecap="round"
              fill="none"
            />
          )
        }
        const common = { className: 'bot-blink', style: { transformOrigin: `${cx}px ${cy}px` } }
        // waiting: occhi leggermente più grandi (pill 16, dot r 5, quadrato 9)
        if (shape === 'square')
          return state === 'waiting' ? (
            <rect key={i} x={cx - 4.5} y={cy - 4.5} width={9} height={9} fill={ink} {...common} />
          ) : (
            <rect key={i} x={cx - 4} y={cy - 4} width={8} height={8} fill={ink} {...common} />
          )
        if (shape === 'dot')
          return (
            <circle key={i} cx={cx} cy={cy} r={state === 'listening' || state === 'waiting' ? 5 : 4} fill={ink} {...common} />
          )
        if (shape === 'line')
          return (
            <line key={i} x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke={ink} strokeWidth={3.5} strokeLinecap="round" {...common} />
          )
        return state === 'waiting' ? (
          <rect key={i} x={cx - 3.5} y={cy - 8} width={7} height={16} rx={3.5} fill={ink} {...common} />
        ) : (
          <rect key={i} x={cx - 3.5} y={cy - 7} width={7} height={14} rx={3.5} fill={ink} {...common} />
        )
      })}
    </g>
  )
}

function Mouth({ state, x, y, ink = 'var(--bot-ink)' }: { state: BotState; x: number; y: number; ink?: string }) {
  if (state === 'speaking')
    return <ellipse cx={x} cy={y} rx={5} ry={3} fill={ink} className="bot-talk" style={{ transformOrigin: `${x}px ${y}px` }} />
  if (state === 'happy') return <path d={`M${x - 6} ${y - 1} Q${x} ${y + 6} ${x + 6} ${y - 1}`} fill={ink} />
  if (state === 'thinking') return <path d={`M${x - 4} ${y} L${x + 4} ${y - 1}`} stroke={ink} strokeWidth={2.5} strokeLinecap="round" />
  // waiting: piccolo arco chiuso, neutro
  if (state === 'waiting')
    return (
      <path d={`M${x - 4} ${y} Q${x} ${y + 3} ${x + 4} ${y}`} stroke={ink} strokeWidth={2.5} strokeLinecap="round" fill="none" />
    )
  return null
}

function Extras({ state }: { state: BotState }) {
  if (state === 'thinking')
    return (
      <g fill="var(--bot-ink)" opacity={0.7}>
        {[0, 1, 2].map((i) => (
          <circle key={i} cx={78 + i * 6} cy={14} r={2} className="bot-dot" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </g>
    )
  return null
}

const JELLY = [
  'M50 12 C74 10 90 28 88 52 C86 76 70 90 48 88 C26 86 10 72 12 50 C14 28 28 14 50 12Z',
  'M52 14 C78 14 88 32 86 54 C84 78 66 88 46 86 C22 84 12 68 14 46 C16 26 30 14 52 14Z',
  'M48 10 C70 12 92 26 88 50 C84 74 72 92 50 90 C28 88 12 76 10 52 C10 30 28 10 48 10Z'
]

const CREATURE = [
  'M50 28 C72 28 84 44 82 62 C80 80 66 88 50 88 C34 88 20 80 18 62 C16 44 28 28 50 28Z',
  'M50 24 C70 26 80 44 80 62 C80 82 64 88 50 88 C36 88 20 82 20 62 C20 44 30 26 50 24Z',
  'M50 32 C76 32 88 46 86 64 C84 80 68 88 50 88 C32 88 16 80 14 64 C12 46 24 32 50 32Z'
]
const ROBO = [
  'M50 22 C70 22 80 32 80 50 C80 70 70 80 50 80 C30 80 20 70 20 50 C20 32 30 22 50 22Z',
  'M50 20 C68 20 78 32 78 50 C78 72 68 82 50 82 C32 82 22 72 22 50 C22 32 32 20 50 20Z',
  'M50 24 C72 24 82 34 82 50 C82 68 72 78 50 78 C28 78 18 68 18 50 C18 34 28 24 50 24Z'
]
const DEVICE = [
  'M50 16 C78 16 86 20 86 46 C86 76 78 84 50 84 C22 84 14 76 14 46 C14 20 22 16 50 16Z',
  'M50 13 C76 14 84 20 84 46 C84 78 76 85 50 85 C24 85 16 78 16 46 C16 20 24 14 50 13Z',
  'M50 19 C80 18 89 22 88 48 C88 75 80 83 50 83 C20 83 12 75 12 48 C11 22 20 18 50 19Z'
]

export function Bot({ family, color, state: stateProp, size = 120, track = true, dimmed = false, label }: BotProps) {
  const ref = useRef<SVGSVGElement>(null)
  const reduced = useReducedMotion()
  const { i18n } = useLingui()
  const [look, setLook] = useState({ x: 0, y: 0 })
  // il movimento ridotto spegne anche lo sguardo, non solo le animazioni CSS
  const follow = track && !reduced && !dimmed

  useEffect(() => {
    if (!follow) return
    // un solo listener condiviso (pointer.ts): qui si legge la posizione e si
    // calcola lo sguardo con la formula di Lovable
    return subscribePointer((p) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setLook(gazeFrom(r.left + r.width / 2, r.top + r.height / 2, p.x, p.y))
    })
  }, [follow])

  // finestra nascosta: lo SMIL si ferma (le animazioni CSS le ferma la classe
  // bots-paused che il listener globale mette su <html>)
  useEffect(
    () =>
      onBotsVisibility((hidden) => {
        const svg = ref.current as
          | (SVGSVGElement & { pauseAnimations?: () => void; unpauseAnimations?: () => void })
          | null
        if (!svg) return
        if (hidden) svg.pauseAnimations?.()
        else svg.unpauseAnimations?.()
      }),
    []
  )

  const state: BotState = dimmed ? 'idle' : stateProp
  const fill = `var(--bot-${color})`
  const wrap = `bot bot--${family} bot--${state}${dimmed ? ' bot--dimmed' : ''}`
  // con il movimento ridotto le <animate> SMIL non si rendono affatto
  const smil = (props: { attributeName: string; dur: string; values: string }) =>
    reduced ? null : <animate repeatCount="indefinite" {...props} />

  let body: React.ReactNode = null
  switch (family) {
    case 'jelly':
      body = (
        <>
          <path fill={fill} d={JELLY[0]}>
            {smil({ attributeName: 'd', dur: state === 'speaking' ? '0.9s' : '4s', values: `${JELLY[0]};${JELLY[1]};${JELLY[2]};${JELLY[0]}` })}
          </path>
          <ellipse cx={36} cy={30} rx={10} ry={5} fill="white" opacity={0.25} transform="rotate(-25 36 30)" />
          <Eyes state={state} look={look} pos={[[42, 46], [58, 46]]} />
          <Mouth state={state} x={50} y={62} />
        </>
      )
      break
    case 'pixel': {
      const cells: [number, number][] = []
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const corner = (r === 0 || r === 7) && (c === 0 || c === 7)
          if (!corner) cells.push([c, r])
        }
      body = (
        <>
          <g className="bot-pixel-grid">
            {cells.map(([c, r]) => (
              <rect
                key={`${c}-${r}`}
                x={14 + c * 9}
                y={14 + r * 9}
                width={8.4}
                height={8.4}
                rx={1.5}
                fill={fill}
                style={{ animationDelay: `${(c + r) * 0.05}s` }}
              />
            ))}
          </g>
          <Eyes state={state} look={look} pos={[[37, 45], [63, 45]]} shape="square" />
          <Mouth state={state} x={50} y={64} />
        </>
      )
      break
    }
    case 'h-creature': {
      const dur = state === 'speaking' ? '0.8s' : state === 'thinking' ? '2.2s' : '3.6s'
      body = (
        <>
          <g className="hm-ear hm-ear--l"><path d="M32 34 C26 20 28 10 34 8 C40 10 42 22 40 32Z" fill={fill} /></g>
          <g className="hm-ear hm-ear--r"><path d="M68 34 C74 20 72 10 66 8 C60 10 58 22 60 32Z" fill={fill} /></g>
          <path fill={fill} d={CREATURE[0]}>
            {smil({ attributeName: 'd', dur, values: `${CREATURE[0]};${CREATURE[1]};${CREATURE[2]};${CREATURE[0]}` })}
          </path>
          <ellipse cx={38} cy={40} rx={8} ry={4} fill="white" opacity={0.25} transform="rotate(-25 38 40)" />
          <circle cx={34} cy={66} r={4} fill="var(--bot-blush)" opacity={0.55} />
          <circle cx={66} cy={66} r={4} fill="var(--bot-blush)" opacity={0.55} />
          <Eyes state={state} look={look} pos={[[42, 56], [58, 56]]} />
          <Mouth state={state} x={50} y={70} />
        </>
      )
      break
    }
    case 'h-robo': {
      const dur = state === 'speaking' ? '0.7s' : '3.2s'
      body = (
        <>
          <path d="M50 22 Q46 14 50 8" stroke="var(--bot-ink)" strokeWidth={2.5} fill="none" strokeLinecap="round" className="hm-antenna" />
          {/* waiting: la pallina dell'antenna pulsa (opacity 1 → .4) */}
          <circle cx={50} cy={8} r={4.5} fill={fill} className="hm-antenna hm-antenna-ball" />
          <path fill={fill} d={ROBO[0]}>
            {smil({ attributeName: 'd', dur, values: `${ROBO[0]};${ROBO[1]};${ROBO[2]};${ROBO[0]}` })}
          </path>
          <rect x={28} y={34} width={44} height={26} rx={13} fill="var(--bot-screen)" />
          <Eyes state={state} look={look} pos={[[41, 47], [59, 47]]} ink={fill} />
          <Mouth state={state} x={50} y={70} />
          <circle cx={12} cy={60} r={7} fill={fill} className="hm-hand hm-hand--l" style={{ transform: `translate(${look.x}px, ${look.y}px)` }} />
          <circle cx={88} cy={60} r={7} fill={fill} className="hm-hand hm-hand--r" style={{ transform: `translate(${look.x}px, ${look.y}px)` }} />
        </>
      )
      break
    }
    case 'h-device': {
      const dur = state === 'speaking' ? '0.6s' : '3.8s'
      body = (
        <>
          <path fill={fill} d={DEVICE[0]}>
            {smil({ attributeName: 'd', dur, values: `${DEVICE[0]};${DEVICE[1]};${DEVICE[2]};${DEVICE[0]}` })}
          </path>
          <rect x={24} y={26} width={52} height={38} rx={12} fill="var(--bot-screen)" className="hm-screen" />
          <g className="hm-scan"><rect x={24} y={26} width={52} height={4} rx={2} fill={fill} opacity={0.25} /></g>
          <Eyes state={state} look={look} pos={[[40, 43], [60, 43]]} shape="dot" ink={fill} />
          <Mouth state={state} x={50} y={55} ink={fill} />
          <circle cx={30} cy={74} r={2.5} fill="var(--bot-ink)" opacity={0.5} />
          <circle cx={38} cy={74} r={2.5} fill="var(--bot-ink)" opacity={0.5} />
          <ellipse cx={36} cy={90} rx={7} ry={4} fill={fill} className="hm-foot" />
          <ellipse cx={64} cy={90} rx={7} ry={4} fill={fill} className="hm-foot" style={{ animationDelay: '.2s' }} />
        </>
      )
      break
    }
  }

  return (
    <div
      className={wrap}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label ? i18n.t(botAriaLabel(label, state)) : undefined}
      aria-hidden={label ? undefined : true}
    >
      {state === 'listening' && (
        <>
          <span className="bot-wave" style={{ borderColor: fill }} />
          <span className="bot-wave" style={{ borderColor: fill, animationDelay: '.6s' }} />
        </>
      )}
      {/* waiting: pallino di attenzione fuori dall'SVG, in alto a destra */}
      {state === 'waiting' && <span className="bot-attn" style={{ background: fill }} />}
      <svg ref={ref} viewBox="0 0 100 100" width={size} height={size} className="bot-svg" overflow="visible">
        {body}
        <Extras state={state} />
      </svg>
    </div>
  )
}
