import { useEffect, useRef, useState } from 'react';
import { feedApi } from './feedApi';
import { useViewport } from '../store/useViewport';
import { useMountedMedia } from './useMountedMedia';
import { pdfPageInfo } from './pdfModel';
import {
  PDF_FALLBACK_WIDTH,
  PDF_ZOOM_STEPS,
  renderPdfPage,
} from './pdfRuntime';
import { PdfFallbackOverlay, PdfOverlay } from './PdfOverlay';
import './pdf-card.css';
import { cx } from '../utils/format';

export { pdfPageInfo } from './pdfModel';

/**
 * Render a linked PDF page on demand. pdfRuntime owns loading/caching; the
 * overlay is presentational; this component owns only interaction state.
 */
export default function PdfPageCard({ post, projectId, info }) {
  const isMobile = useViewport();
  const [state, setState] = useState('poster');
  const [render, setRender] = useState(null);
  const [zoom, setZoom] = useState('fit');
  const [rezooming, setRezooming] = useState(false);
  const [mobileOverlayVisible, setMobileOverlayVisible] = useState(false);
  const boxRef = useRef(null);
  const scrollRef = useRef(null);
  const trackedRef = useRef(false);
  const closedByUserRef = useRef(false);
  const mobileTimerRef = useRef(null);
  const dragRef = useRef(null);

  const hasMeta = Boolean(info.title && (info.authors?.length || info.year));
  const zoomedIn = zoom !== 'fit';
  const containerWidth = () => (
    boxRef.current?.clientWidth || PDF_FALLBACK_WIDTH
  );

  const open = () => {
    if (state === 'loading' || closedByUserRef.current) return;
    setState('loading');
    renderPdfPage(info.url, info.page, 'fit', containerWidth())
      .then((nextRender) => {
        setRender(nextRender);
        setState('open');
        if (!trackedRef.current) {
          trackedRef.current = true;
          feedApi.trackFeed(
            projectId,
            'image_viewed',
            { post_id: post.id },
          ).catch(() => {});
        }
      })
      .catch(() => setState('error'));
  };

  const close = () => {
    setState('poster');
    setZoom('fit');
    setMobileOverlayVisible(false);
    if (mobileTimerRef.current) {
      clearTimeout(mobileTimerRef.current);
      mobileTimerRef.current = null;
    }
  };

  const closeByUser = () => {
    closedByUserRef.current = true;
    close();
  };

  const applyZoom = (nextZoom) => {
    if (nextZoom === zoom) return;
    setZoom(nextZoom);
    setRezooming(true);
    renderPdfPage(info.url, info.page, nextZoom, containerWidth())
      .then((nextRender) => {
        setRender(nextRender);
        setRezooming(false);
      })
      .catch(() => setRezooming(false));
  };

  const zoomIn = () => {
    const index = PDF_ZOOM_STEPS.indexOf(zoom);
    applyZoom(PDF_ZOOM_STEPS[Math.min(index + 1, PDF_ZOOM_STEPS.length - 1)]);
  };
  const zoomOut = () => {
    const index = PDF_ZOOM_STEPS.indexOf(zoom);
    applyZoom(PDF_ZOOM_STEPS[Math.max(index - 1, 0)]);
  };
  const zoomReset = () => applyZoom('fit');

  const handlePointerDown = (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !zoomedIn) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (event.target.closest('.postcard-pdf-overlay, .postcard-embed-close')) {
      return;
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: scroll.scrollLeft,
      startTop: scroll.scrollTop,
      dragging: false,
      pointerId: event.pointerId,
    };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    if (!drag || !scroll || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      drag.dragging = true;
      try {
        scroll.setPointerCapture(drag.pointerId);
      } catch {
        // The pointer may already be gone.
      }
      scroll.classList.add('postcard-pdf-scroll--dragging');
    }
    event.preventDefault();
    scroll.scrollLeft = drag.startLeft - dx;
    scroll.scrollTop = drag.startTop - dy;
  };

  const endDrag = () => {
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    if (drag?.dragging && scroll) {
      if (scroll.hasPointerCapture?.(drag.pointerId)) {
        scroll.releasePointerCapture(drag.pointerId);
      }
      scroll.classList.remove('postcard-pdf-scroll--dragging');
    }
    dragRef.current = null;
  };

  const handleMobileTap = () => {
    if (!isMobile) return;
    if (mobileTimerRef.current) {
      clearTimeout(mobileTimerRef.current);
      mobileTimerRef.current = null;
    }
    setMobileOverlayVisible((visible) => !visible);
  };

  useEffect(() => {
    if (!isMobile || state !== 'open') return undefined;
    setMobileOverlayVisible(true);
    mobileTimerRef.current = setTimeout(
      () => setMobileOverlayVisible(false),
      2500,
    );
    return () => {
      if (mobileTimerRef.current) clearTimeout(mobileTimerRef.current);
    };
  }, [isMobile, state, render]);

  useMountedMedia({ isMobile, state, rootRef: boxRef, open, close });

  if (state === 'open' && render) {
    const classes = cx(
      'postcard-media',
      'postcard-pdf',
      'postcard-pdf--open',
      zoomedIn ? 'postcard-pdf--zoomed' : '',
    );
    return (
      <div className={classes} ref={boxRef} tabIndex={-1}>
        <div
          className="postcard-pdf-scroll"
          ref={scrollRef}
          tabIndex={zoomedIn ? 0 : -1}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            className="postcard-pdf-canvas"
            src={render.dataUrl}
            alt={`${info.title}, page ${render.clampedPage}`}
            draggable={false}
            onDoubleClick={() => { if (!isMobile) zoomIn(); }}
            onClick={handleMobileTap}
            style={{
              width: `${render.cssWidth}px`,
              height: `${render.cssHeight}px`,
              opacity: rezooming ? 0.6 : undefined,
            }}
          />
        </div>
        {hasMeta ? (
          <PdfOverlay
            info={info}
            zoom={zoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
            showZoom
            visible={isMobile ? mobileOverlayVisible : false}
          />
        ) : (
          <PdfFallbackOverlay
            info={info}
            visible={isMobile ? mobileOverlayVisible : false}
          />
        )}
        <button
          type="button"
          className="postcard-embed-close"
          aria-label="Close paper page"
          onClick={closeByUser}
        >
          ✕
        </button>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div
        className="postcard-media postcard-pdf postcard-pdf--open"
        ref={boxRef}
      >
        <iframe
          className="postcard-pdf-frame"
          src={info.url}
          loading="lazy"
          title={info.title}
        />
        {hasMeta ? (
          <PdfOverlay info={info} showZoom={false} persistent />
        ) : (
          <PdfFallbackOverlay info={info} persistent />
        )}
        <button
          type="button"
          className="postcard-embed-close"
          aria-label="Close paper page"
          onClick={closeByUser}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="postcard-media postcard-pdf" ref={boxRef}>
      <button
        type="button"
        className="postcard-pdfposter"
        onClick={open}
        disabled={state === 'loading'}
        aria-label={`Open ${info.title}, page ${info.page}`}
      >
        <span className="postcard-pdfposter-title">{info.title}</span>
        <span className="postcard-pdfposter-page">
          {state === 'loading' ? 'loading…' : `page ${info.page}`}
        </span>
      </button>
    </div>
  );
}
