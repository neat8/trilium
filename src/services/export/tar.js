"use strict";

const html = require('html');
const repository = require('../repository');
const tar = require('tar-stream');
const path = require('path');
const sanitize = require("sanitize-filename");
const mimeTypes = require('mime-types');
const TurndownService = require('turndown');

/**
 * @param format - 'html' or 'markdown'
 */
async function exportToTar(branch, format, res) {
    let turndownService = format === 'markdown' ? new TurndownService() : null;

    const pack = tar.pack();

    const noteIdToMeta = {};

    function getUniqueFilename(existingFileNames, fileName) {
        const lcFileName = fileName.toLowerCase();

        if (lcFileName in existingFileNames) {
            let index;
            let newName;

            do {
                index = existingFileNames[lcFileName]++;

                newName = lcFileName + "_" + index;
            }
            while (newName in existingFileNames);

            return fileName + "_" + index;
        }
        else {
            existingFileNames[lcFileName] = 1;

            return fileName;
        }
    }

    function getDataFileName(note, baseFileName, existingFileNames) {
        let extension;

        if (note.type === 'text' && format === 'markdown') {
            extension = 'md';
        }
        else if (note.mime === 'application/x-javascript') {
            extension = 'js';
        }
        else {
            extension = mimeTypes.extension(note.mime) || "dat";
        }

        let fileName = baseFileName;

        if (!fileName.toLowerCase().endsWith(extension)) {
            fileName += "." + extension;
        }

        return getUniqueFilename(existingFileNames, fileName);
    }

    async function getNote(branch, existingFileNames) {
        const note = await branch.getNote();

        if (await note.hasLabel('excludeFromExport')) {
            return;
        }

        const baseFileName = branch.prefix ? (branch.prefix + ' - ' + note.title) : note.title;

        if (note.noteId in noteIdToMeta) {
            const sanitizedFileName = sanitize(baseFileName + ".clone");
            const fileName = getUniqueFilename(existingFileNames, sanitizedFileName);

            return {
                clone: true,
                noteId: note.noteId,
                prefix: branch.prefix,
                dataFileName: fileName
            };
        }

        const meta = {
            clone: false,
            noteId: note.noteId,
            title: note.title,
            prefix: branch.prefix,
            isExpanded: branch.isExpanded,
            type: note.type,
            mime: note.mime,
            // we don't export dateCreated and dateModified of any entity since that would be a bit misleading
            attributes: (await note.getOwnedAttributes()).map(attribute => {
                return {
                    type: attribute.type,
                    name: attribute.name,
                    value: attribute.value,
                    isInheritable: attribute.isInheritable,
                    position: attribute.position
                };
            }),
            links: (await note.getLinks()).map(link => {
                return {
                    type: link.type,
                    targetNoteId: link.targetNoteId
                }
            })
        };

        if (note.type === 'text') {
            meta.format = format;
        }

        noteIdToMeta[note.noteId] = meta;

        const childBranches = await note.getChildBranches();

        // if it's a leaf then we'll export it even if it's empty
        if (note.content.length > 0 || childBranches.length === 0) {
            meta.dataFileName = getDataFileName(note, baseFileName, existingFileNames);
        }

        if (childBranches.length > 0) {
            meta.dirFileName = getUniqueFilename(existingFileNames, baseFileName);
            meta.children = [];

            const childExistingNames = {};

            for (const childBranch of childBranches) {
                const note = await getNote(childBranch, existingFileNames);

                // can be undefined if export is disabled for this note
                if (note) {
                    meta.children.push(note);
                }
            }
        }

        return meta;
    }

    function prepareContent(note, format) {
        if (format === 'html') {
            return html.prettyPrint(note.content, {indent_size: 2});
        }
        else if (format === 'markdown') {
            return turndownService.turndown(note.content);
        }
        else {
            return note.content;
        }
    }

    // noteId => file path
    const notePaths = {};

    async function saveNote(noteMeta, path) {
        if (noteMeta.clone) {
            const content = "Note is present at " + notePaths[noteMeta.noteId];

            pack.entry({name: path + '/' + noteMeta.dataFileName, size: content.length}, content);
            return;
        }

        const note = await repository.getNote(noteMeta.noteId);

        notePaths[note.noteId] = path + '/' + (noteMeta.dataFileName || noteMeta.dirFileName);

        if (noteMeta.dataFileName) {
            const content = prepareContent(note, noteMeta.format);

            pack.entry({name: path + '/' + noteMeta.dataFileName, size: content.length}, content);
        }

        if (noteMeta.children && noteMeta.children.length > 0) {
            const directoryPath = path + '/' + noteMeta.dirFileName;

            pack.entry({name: directoryPath, type: 'directory'});

            for (const childMeta of noteMeta.children) {
                await saveNote(childMeta, directoryPath);
            }
        }
    }

    const metaFile = {
        version: 1,
        files: [
            await getNote(branch, [])
        ]
    };

    for (const noteMeta of Object.values(noteIdToMeta)) {
        // filter out relations and links which are not inside this export
        noteMeta.attributes = noteMeta.attributes.filter(attr => attr.type !== 'relation' || attr.value in noteIdToMeta);
        noteMeta.links = noteMeta.links.filter(link => link.targetNoteId in noteIdToMeta);
    }

    if (!metaFile.files[0]) { // corner case of disabled export for exported note
        res.sendStatus(400);
        return;
    }

    const metaFileJson = JSON.stringify(metaFile, null, '\t');

    pack.entry({name: "!!!meta.json", size: metaFileJson.length}, metaFileJson);

    await saveNote(metaFile.files[0], '');

    pack.finalize();

    const note = await branch.getNote();
    const tarFileName = sanitize((branch.prefix ? (branch.prefix + " - ") : "") + note.title);

    res.setHeader('Content-Disposition', `file; filename="${tarFileName}.tar"`);
    res.setHeader('Content-Type', 'application/tar');

    pack.pipe(res);
}

module.exports = {
    exportToTar
};