import { Router } from 'express';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { EPC_BITS, EpcEncodeError, encodeBarcodeToEpcHex } from '../lib/rfid.js';
export const rfidRouter = Router();
rfidRouter.use(requireAuth);
/**
 * Preview-only: computes the hex a PDA should Write to a blank tag's EPC
 * bank for this barcode. Doesn't touch the database — the box only actually
 * gets tagged once the PDA reads the write back and calls
 * POST /api/boxes/:tag/rfid with what's really on the chip (see boxes.ts).
 */
rfidRouter.get('/encode/:tag', asyncHandler(async (req, res) => {
    const bits = req.query.bits === '128' ? EPC_BITS.EPC_128 : EPC_BITS.EPC_96;
    try {
        const epcHex = encodeBarcodeToEpcHex(req.params.tag, bits);
        res.json({ tag: req.params.tag, bits, epcHex });
    }
    catch (e) {
        if (e instanceof EpcEncodeError)
            throw httpError(400, e.message, 'epc_encode_error');
        throw e;
    }
}));
export default rfidRouter;
//# sourceMappingURL=rfid.js.map