import StandardWidget from "./standard_widget.js";
import linkService from "../services/link.js";
import server from "../services/server.js";
import treeCache from "../services/tree_cache.js";
import treeUtils from "../services/tree_utils.js";
import treeService from "../services/tree.js";

class SimilarNotesWidget extends StandardWidget {
    getWidgetTitle() { return "Similar notes"; }

    getMaxHeight() { return "200px"; }

    async doRenderBody() {
        const similarNotes = await server.get('similar_notes/' + this.ctx.note.noteId);

        if (similarNotes.length === 0) {
            this.$body.text("No similar notes found ...");
            return;
        }

        const noteIds = similarNotes.flatMap(note => note.notePath);

        await treeCache.getNotes(noteIds); // preload all at once

        const $list = $('<ul>');

        for (const similarNote of similarNotes) {
            const note = await treeCache.getNote(similarNote.noteId);

            if (!note) {
                continue;
            }

            const $item = $("<li>")
                .append(await linkService.createNoteLinkWithPath(similarNote.notePath.join("/")));

            $list.append($item);
        }

        this.$body.empty().append($list);
    }
}

export default SimilarNotesWidget;