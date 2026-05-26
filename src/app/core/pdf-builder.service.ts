import { Injectable } from '@angular/core';
import { jsPDF } from 'jspdf';

import { MyUserProfile, Office } from './api.types';

export const PDF_MARGIN = 14;

export const PAYMENT_PENDING_LABEL = 'Paiement en attente';

export interface ConsultationInvoiceFormData {
  quantity: string | number | null;
  amountHt: string | number | null;
  tvaRate: string | number | null;
  serviceLabel: string | null;
  paymentMethod: string | null;
  socialSecurityNumber: string | null;
  insurance: string | null;
  lastName: string | null;
  firstName: string | null;
  address1: string | null;
  address2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  birthDate: string | null;
}

@Injectable({ providedIn: 'root' })
export class PdfBuilderService {

  normalizeMultilineText(value: string): string {
    return String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  formatShortDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date);
  }

  buildLegalFooterText(
    profile: MyUserProfile | null,
    office: Office | null,
    includeVatMention = false
  ): string {
    const appendLegalCode = (parts: string[], label: string, rawValue: unknown): void => {
      const value = String(rawValue ?? '').trim();
      if (!value) {
        return;
      }
      parts.push(`${label}: ${value}`);
    };

    const practitionerParts: string[] = [];
    appendLegalCode(practitionerParts, 'SIRET', profile?.siret);
    appendLegalCode(practitionerParts, 'RPPS', profile?.rppsCode);
    appendLegalCode(practitionerParts, 'APE', profile?.apeNafCode);
    appendLegalCode(practitionerParts, 'ADELI', profile?.adeliCode);

    const sections = [
      `Praticien - ${practitionerParts.length ? practitionerParts.join(' | ') : 'Aucun code renseigne'}`
    ];

    if (includeVatMention && !office?.hideVatMention) {
      sections.push('TVA non applicable, art. 261-4-1 du CGI');
    }

    return sections.join(' || ');
  }

  /**
   * Renders the unified document header: logo (when available) on the left, office
   * name / practitioner / address block to the right, then a horizontal separator.
   *
   * @returns The Y position immediately after the header separator, ready for body content.
   */
  writeUnifiedHeader(
    pdf: jsPDF,
    options: {
      office: Office | null;
      profile: MyUserProfile | null;
      officeFallbackName?: string | null;
      margin?: number;
    }
  ): number {
    const margin = options.margin ?? PDF_MARGIN;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const { office, profile } = options;

    const officeName = String(office?.name ?? options.officeFallbackName ?? '').trim() || 'Cabinet';
    const officeHeading = officeName.toLowerCase().startsWith('cabinet')
      ? officeName
      : `Cabinet de ${officeName}`;
    const writerName = profile
      ? `${String(profile.lastName ?? '').trim().toUpperCase()} ${String(profile.firstName ?? '').trim()}`.trim()
      : '';
    const writerNameSuffix = String(profile?.nameSuffixText ?? '').trim();
    const writerLine = [writerName, writerNameSuffix].filter(Boolean).join(' ');
    const officePhone = String(office?.phoneMobile ?? '').trim() || String(office?.phoneLandline ?? '').trim();
    const officeEmail = String(office?.email ?? '').trim();
    const officeWebsite = String(office?.website ?? '').trim().replace(/^https?:\/\//i, '');
    const addressParts = [
      String(office?.addressLine1 ?? '').trim(),
      `${String(office?.postalCode ?? '').trim()} ${String(office?.city ?? '').trim()}`.trim()
    ].filter(Boolean);
    const addressLine = addressParts.join(' ');

    const hasLogo = !!(office?.logoData && office.logoData.startsWith('data:image/'));
    const startY = margin;

    if (hasLogo) {
      const logoData = office!.logoData!;
      const format = logoData.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      try {
        pdf.addImage(logoData, format, margin, startY, 18, 18);
      } catch {
        // Continue without logo if image fails to load
      }
    }

    const textX = margin + (hasLogo ? 20 : 2);
    let lineY = startY + 5;

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text(officeHeading, textX, lineY);
    lineY += 6;

    if (writerLine) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10.5);
      pdf.text(writerLine, textX, lineY);
      lineY += 5;
    }

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9.5);

    const infoLines = [
      addressLine,
      officePhone ? `Port. : ${officePhone}` : '',
      officeEmail,
      officeWebsite
    ].filter(Boolean);

    for (const line of infoLines) {
      pdf.text(line, textX, lineY);
      lineY += 4.5;
    }

    // Ensure content stays below the logo when present
    let y = Math.max(lineY + 2, hasLogo ? startY + 21 : lineY + 2);

    pdf.setDrawColor(210, 219, 230);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 7;

    return y;
  }

  /**
   * Renders the legal footer (SIRET, RPPS, ADELI, APE, optional VAT mention) at the
   * bottom of the current page with a separator line above.
   */
  writeUnifiedFooter(
    pdf: jsPDF,
    options: {
      margin: number;
      pageWidth: number;
      pageHeight: number;
      profile: MyUserProfile | null;
      office: Office | null;
      includeVatMention?: boolean;
    }
  ): void {
    const { margin, pageWidth, pageHeight, profile, office, includeVatMention = false } = options;
    const contentWidth = pageWidth - (margin * 2);
    const footerText = this.buildLegalFooterText(profile, office, includeVatMention);
    const footerLines = pdf.splitTextToSize(footerText, contentWidth) as string[];
    const lineHeight = 3.6;
    const footerY = pageHeight - 8 - ((footerLines.length - 1) * lineHeight);

    pdf.setDrawColor(214, 220, 229);
    pdf.line(margin, footerY - 4, pageWidth - margin, footerY - 4);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(footerLines, margin, footerY);
  }

  /**
   * Builds the consultation invoice PDF from normalised form data and returns a Blob.
   * This centralises the duplicated invoice-building logic previously spread across
   * patient-create.page.ts and patient-detail.page.ts.
   */
  buildConsultationInvoicePdf(
    rawData: ConsultationInvoiceFormData,
    office: Office | null,
    profile: MyUserProfile,
    issuedAtIso: string,
    invoiceNumber: string,
    officeFallbackName?: string | null
  ): Blob {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2);
    const currency = String(office?.devise ?? 'EUR').trim() || 'EUR';
    const quantity = Math.max(0, Number(rawData.quantity) || 0);
    const unitPrice = Math.max(0, Number(rawData.amountHt) || 0);
    const tvaRate = Math.max(0, Number(rawData.tvaRate) || 0);
    const totalHt = Number((quantity * unitPrice).toFixed(2));
    const totalTva = Number((totalHt * (tvaRate / 100)).toFixed(2));
    const totalAmount = Number((totalHt + totalTva).toFixed(2));

    const drawBox = (x: number, y: number, w: number, h: number): void => {
      pdf.setDrawColor(206, 214, 226);
      pdf.rect(x, y, w, h);
    };

    const writeRight = (text: string, xRight: number, y: number): void => {
      const width = pdf.getTextWidth(text);
      pdf.text(text, xRight - width, y);
    };

    const drawSection = (title: string, x: number, y: number, w: number, h: number, lines: string[]): void => {
      drawBox(x, y, w, h);
      pdf.setFillColor(246, 248, 251);
      pdf.rect(x, y, w, 6, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(title, x + 2, y + 4.2);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.6);
      let lineY = y + 10;
      for (const line of lines) {
        if (lineY > y + h - 2) {
          break;
        }
        pdf.text(line, x + 2, lineY);
        lineY += 4;
      }
    };

    let y = margin;

    // ── Office + FACTURE header block ─────────────────────────
    const officeX = margin;
    const officeW = contentWidth * 0.58;
    const invoiceX = officeX + officeW + 4;
    const invoiceW = contentWidth - officeW - 4;
    const topBlockH = 44;

    drawBox(officeX, y, officeW, topBlockH);

    if (office?.logoData && office.logoData.startsWith('data:image/')) {
      const format = office.logoData.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      try {
        pdf.addImage(office.logoData, format, officeX + 2, y + 2, 16, 16);
      } catch {
        // Keep generating even if logo is invalid.
      }
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    const officeName = String(office?.name ?? officeFallbackName ?? 'Cabinet').trim() || 'Cabinet';
    const officeHeading = officeName.toLowerCase().startsWith('cabinet')
      ? officeName
      : `Cabinet de ${officeName}`;
    pdf.text(officeHeading, officeX + 21, y + 7);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);

    const topLeftLines = [
      `${String(profile.lastName ?? '').trim()} ${String(profile.firstName ?? '').trim()}`.trim(),
      String(profile.nameSuffixText ?? '').trim(),
      String(office?.addressLine1 ?? '').trim(),
      String(office?.addressLine2 ?? '').trim(),
      `${String(office?.postalCode ?? '').trim()} ${String(office?.city ?? '').trim()}`.trim(),
      String(office?.email ?? '').trim(),
      String(office?.website ?? '').trim()
    ].filter(Boolean);

    let topY = y + 12;
    for (const line of topLeftLines) {
      pdf.text(line, officeX + 21, topY);
      topY += 3.8;
      if (topY > y + topBlockH - 2) {
        break;
      }
    }

    drawBox(invoiceX, y, invoiceW, topBlockH);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(22);
    writeRight('FACTURE', invoiceX + invoiceW - 3, y + 11);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    writeRight(`N° ${invoiceNumber}`, invoiceX + invoiceW - 3, y + 19);
    writeRight(`Date : ${this.formatShortDate(issuedAtIso)}`, invoiceX + invoiceW - 3, y + 24);
    writeRight(`Échéance : ${this.formatShortDate(issuedAtIso)}`, invoiceX + invoiceW - 3, y + 29);

    pdf.setDrawColor(200, 40, 40);
    pdf.setTextColor(200, 40, 40);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    writeRight('FACTURE ACQUITÉE', invoiceX + invoiceW - 3, y + 39);
    pdf.setTextColor(0, 0, 0);

    y += topBlockH + 6;

    // ── Invoice info + Patient blocks ─────────────────────────
    const leftInfoW = contentWidth * 0.5;
    const rightInfoX = margin + leftInfoW + 4;
    const rightInfoW = contentWidth - leftInfoW - 4;
    const blockH = 36;

    drawSection('Informations facture', margin, y, leftInfoW, blockH, [
      `N° facture : ${invoiceNumber}`,
      `Date facture : ${this.formatShortDate(issuedAtIso)}`,
      `N° Sécu: ${String(rawData.socialSecurityNumber ?? '').trim() || '-'}`,
      `N° Mutuelle: ${String(rawData.insurance ?? '').trim() || '-'}`
    ]);

    const patientLines = [
      `${String(rawData.lastName ?? '').trim()} ${String(rawData.firstName ?? '').trim()}`.trim(),
      String(rawData.address1 ?? '').trim(),
      String(rawData.address2 ?? '').trim(),
      `${String(rawData.postalCode ?? '').trim()} ${String(rawData.city ?? '').trim()}`.trim(),
      String(rawData.country ?? '').trim()
    ].filter(Boolean);

    const birthDateLine = this.formatShortDate(String(rawData.birthDate ?? '').trim());
    if (birthDateLine && birthDateLine !== String(rawData.birthDate ?? '').trim()) {
      patientLines.push(`Date de naissance : ${birthDateLine}`);
    }

    drawSection('A l\'attention de :', rightInfoX, y, rightInfoW, blockH, patientLines);

    y += blockH + 8;

    // ── Line items table ──────────────────────────────────────
    const tableX = margin;
    const tableW = contentWidth;
    const headerH = 7;
    const rowH = 9;
    const tableH = headerH + rowH;

    drawBox(tableX, y, tableW, tableH);
    pdf.setFillColor(246, 248, 251);
    pdf.rect(tableX, y, tableW, headerH, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.8);
    pdf.text('Description', tableX + 2, y + 4.6);
    pdf.text('Qté', tableX + (tableW * 0.56), y + 4.6);
    pdf.text('PU HT', tableX + (tableW * 0.66), y + 4.6);
    pdf.text('TVA', tableX + (tableW * 0.78), y + 4.6);
    pdf.text('Total TTC', tableX + (tableW * 0.88), y + 4.6);
    pdf.line(tableX, y + headerH, tableX + tableW, y + headerH);

    const colQty = tableX + (tableW * 0.54);
    const colPu = tableX + (tableW * 0.64);
    const colTva = tableX + (tableW * 0.76);
    const colTotal = tableX + (tableW * 0.86);
    pdf.line(colQty, y, colQty, y + tableH);
    pdf.line(colPu, y, colPu, y + tableH);
    pdf.line(colTva, y, colTva, y + tableH);
    pdf.line(colTotal, y, colTotal, y + tableH);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);
    pdf.text(String(rawData.serviceLabel ?? '').trim() || 'Consultation', tableX + 2, y + headerH + 5.2);
    pdf.text(String(quantity), colQty + 2, y + headerH + 5.2);
    pdf.text(`${unitPrice.toFixed(2)} ${currency}`, colPu + 2, y + headerH + 5.2);
    pdf.text(`${tvaRate.toFixed(2)} %`, colTva + 2, y + headerH + 5.2);
    writeRight(`${totalAmount.toFixed(2)} ${currency}`, tableX + tableW - 2, y + headerH + 5.2);

    y += tableH + 4;

    // ── Totals block ──────────────────────────────────────────
    const totalsX = tableX + (tableW * 0.58);
    const totalsW = tableX + tableW - totalsX;
    const totalsRowH = 6.5;
    drawBox(totalsX, y, totalsW, totalsRowH * 3);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);
    pdf.text('Total HT', totalsX + 2, y + 4.5);
    writeRight(`${totalHt.toFixed(2)} ${currency}`, totalsX + totalsW - 2, y + 4.5);
    pdf.line(totalsX, y + totalsRowH, totalsX + totalsW, y + totalsRowH);
    pdf.text(`TVA (${tvaRate.toFixed(2)} %)`, totalsX + 2, y + totalsRowH + 4.5);
    writeRight(`${totalTva.toFixed(2)} ${currency}`, totalsX + totalsW - 2, y + totalsRowH + 4.5);
    pdf.line(totalsX, y + (totalsRowH * 2), totalsX + totalsW, y + (totalsRowH * 2));
    pdf.setFont('helvetica', 'bold');
    pdf.text('Total TTC', totalsX + 2, y + (totalsRowH * 2) + 4.5);
    writeRight(`${totalAmount.toFixed(2)} ${currency}`, totalsX + totalsW - 2, y + (totalsRowH * 2) + 4.5);

    y += (totalsRowH * 3) + 7;

    // ── Payment + Signature blocks ────────────────────────────
    const paymentBoxH = 20;
    drawSection('Liste des paiements effectués', tableX, y, tableW * 0.62, paymentBoxH, []);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.8);
    const paymentTextY = y + 11;
    pdf.setFont('helvetica', 'normal');
    const paymentMethod = String(rawData.paymentMethod ?? '').trim();
    if (paymentMethod && paymentMethod !== PAYMENT_PENDING_LABEL) {
      pdf.text(
        `${this.formatShortDate(issuedAtIso)} - ${paymentMethod} - ${totalAmount.toFixed(2)} ${currency}`,
        tableX + 2,
        paymentTextY
      );
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(26, 122, 58);
      pdf.text('RÉGLÉ', tableX + 2, paymentTextY + 5);
      pdf.setTextColor(0, 0, 0);
    } else {
      pdf.setTextColor(166, 125, 0);
      pdf.text('Aucun paiement enregistré', tableX + 2, paymentTextY);
      pdf.setTextColor(0, 0, 0);
    }

    const signatureX = tableX + (tableW * 0.65);
    const signatureW = tableX + tableW - signatureX;
    drawBox(signatureX, y, signatureW, paymentBoxH);
    const editionPlace = String(office?.city ?? officeFallbackName ?? '').trim() || 'Cabinet';
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);
    writeRight(`Éditée à ${editionPlace}, le ${this.formatShortDate(issuedAtIso)}`, signatureX + signatureW - 2, y + 7);
    pdf.setFont('helvetica', 'bold');
    writeRight('Signature', signatureX + signatureW - 2, y + 13);
    if (String(profile.signatureText ?? '').trim()) {
      pdf.setFont('helvetica', 'italic');
      writeRight(String(profile.signatureText ?? '').trim(), signatureX + signatureW - 2, y + 18);
    }

    this.writeUnifiedFooter(pdf, { margin, pageWidth, pageHeight, profile, office, includeVatMention: true });

    return pdf.output('blob');
  }

  /**
   * Builds the GDPR consent form PDF. Identical content in both patient-create and
   * patient-detail pages; centralised here to avoid duplication.
   */
  buildConsentFormPdfBlob(office: Office | null, profile: MyUserProfile | null, patientName = ''): Blob {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = PDF_MARGIN;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    const writeLine = (text: string, fontSize = 10, bold = false, spacingAfter = 5): void => {
      pdf.setFont('helvetica', bold ? 'bold' : 'normal');
      pdf.setFontSize(fontSize);
      const lines = pdf.splitTextToSize(this.normalizeMultilineText(text), contentWidth) as string[];
      if (y + lines.length * 5 > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
      pdf.text(lines, margin, y);
      y += lines.length * 5 + spacingAfter;
    };

    const drawRule = (spacingAfter = 5): void => {
      pdf.setDrawColor(200, 210, 220);
      pdf.line(margin, y, pageWidth - margin, y);
      y += spacingAfter;
    };

    // ── Cabinet header ────────────────────────────────────────
    const officeName = String(office?.name ?? '').trim() || 'Cabinet';
    const officeHeading = officeName.toLowerCase().startsWith('cabinet')
      ? officeName
      : `Cabinet de ${officeName}`;
    const practitioner = profile
      ? `${String(profile.lastName ?? '').trim().toUpperCase()} ${String(profile.firstName ?? '').trim()}`.trim()
      : '';
    const suffix = String(profile?.nameSuffixText ?? '').trim();
    const addressLine = [
      String(office?.addressLine1 ?? '').trim(),
      `${String(office?.postalCode ?? '').trim()} ${String(office?.city ?? '').trim()}`.trim()
    ].filter(Boolean).join(' - ');
    const officeContact = [
      String(office?.phoneMobile ?? '').trim() || String(office?.phoneLandline ?? '').trim(),
      String(office?.email ?? '').trim()
    ].filter(Boolean).join(' | ');

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11.5);
    pdf.text(officeHeading, margin, y);
    y += 6;
    if (practitioner) {
      pdf.setFontSize(10.5);
      pdf.text([practitioner, suffix].filter(Boolean).join(' - '), margin, y);
      y += 5;
    }
    if (addressLine) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9.5);
      pdf.text(addressLine, margin, y);
      y += 5;
    }
    if (officeContact) {
      pdf.text(officeContact, margin, y);
      y += 5;
    }
    y += 2;
    drawRule(6);

    // ── Title ─────────────────────────────────────────────────
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(15);
    pdf.text('Formulaire de consentement RGPD', pageWidth / 2, y, { align: 'center' });
    y += 7;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text('Version 1.0', pageWidth / 2, y, { align: 'center' });
    y += 8;

    // ── Identity section ──────────────────────────────────────
    writeLine('1. Identification du patient', 11, true, 3);
    const nameLabel = 'Nom et prénom du patient :';
    const nameValue = patientName ? `  ${patientName}` : '';
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text(nameLabel, margin, y);
    if (nameValue) {
      pdf.setFont('helvetica', 'bold');
      pdf.text(nameValue, margin + pdf.getTextWidth(nameLabel), y);
      pdf.setFont('helvetica', 'normal');
    }
    y += 6;
    if (!patientName) {
      pdf.setDrawColor(160, 170, 185);
      pdf.line(margin + pdf.getTextWidth(nameLabel) + 2, y - 1, pageWidth - margin, y - 1);
      y += 4;
    }
    writeLine('Date de naissance : ______ / ______ / ____________', 10, false, 4);
    y += 3;

    // ── Purpose & data ────────────────────────────────────────
    writeLine('2. Finalité du traitement', 11, true, 3);
    writeLine(
      'Dans le cadre de votre suivi ostéopathique, le cabinet collecte et traite des données personnelles ' +
      'vous concernant. Ces données sont nécessaires à la prise en charge thérapeutique et à la gestion ' +
      'administrative de votre dossier patient.',
      10, false, 4
    );

    writeLine('3. Données collectées', 11, true, 3);
    writeLine(
      '• Données d\'identité : nom, prénom, date de naissance, sexe\n' +
      '• Coordonnées : adresse postale, numéro de téléphone, adresse e-mail\n' +
      '• Données de santé : antécédents médicaux, motifs de consultation, comptes rendus\n' +
      '• Données administratives : numéro de sécurité sociale, mutuelle, informations de facturation',
      10, false, 4
    );

    writeLine('4. Base légale', 11, true, 3);
    writeLine(
      'Le traitement de vos données repose sur :\n' +
      '• L\'exécution du contrat de soins (Art. 6.1.b du RGPD)\n' +
      '• La nécessité pour des finalités de médecine préventive et de soins de santé (Art. 9.2.h du RGPD)\n' +
      '• Votre consentement explicite pour les données de santé à caractère sensible (Art. 9.2.a du RGPD)',
      10, false, 4
    );

    writeLine('5. Durée de conservation', 11, true, 3);
    writeLine(
      'Vos données sont conservées pour une durée de 10 ans à compter de votre dernière consultation, ' +
      'conformément aux recommandations de la CNIL pour les professionnels de santé. ' +
      'Passé ce délai, vos données sont anonymisées ou supprimées.',
      10, false, 4
    );

    writeLine('6. Vos droits', 11, true, 3);
    writeLine(
      'Conformément au RGPD (Articles 15 à 22), vous disposez des droits suivants :\n' +
      '• Droit d\'accès à vos données personnelles\n' +
      '• Droit de rectification en cas de données inexactes\n' +
      '• Droit à l\'effacement (« droit à l\'oubli »)\n' +
      '• Droit à la limitation du traitement\n' +
      '• Droit à la portabilité de vos données\n' +
      '• Droit d\'opposition au traitement\n' +
      '• Droit de retirer votre consentement à tout moment, sans que cela affecte la licéité du traitement ' +
      'antérieur au retrait\n\n' +
      'Pour exercer ces droits, contactez le cabinet à l\'adresse indiquée en en-tête. ' +
      'Vous disposez également du droit d\'introduire une réclamation auprès de la CNIL (www.cnil.fr).',
      10, false, 4
    );

    // ── Consent declaration ───────────────────────────────────
    if (y + 28 > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
    writeLine('7. Déclaration de consentement', 11, true, 3);
    writeLine(
      'Je soussigné(e), après avoir pris connaissance des informations ci-dessus, consens librement et ' +
      'en connaissance de cause au traitement de mes données personnelles et de mes données de santé ' +
      'par le cabinet aux fins décrites dans ce document.\n\n' +
      'Je reconnais avoir été informé(e) de mon droit de retirer ce consentement à tout moment.',
      10, false, 6
    );

    // ── Signature zone ────────────────────────────────────────
    if (y + 40 > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
    y += 2;
    drawRule(6);

    const colLeft = margin;
    const colRight = pageWidth / 2 + 4;
    const boxWidth = contentWidth / 2 - 4;
    const boxHeight = 24;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text('Date et lieu :', colLeft, y);
    pdf.setDrawColor(160, 170, 185);
    pdf.rect(colLeft, y + 2, boxWidth, boxHeight);

    pdf.text('Signature du patient (précédée de « Lu et approuvé ») :', colRight, y);
    pdf.rect(colRight, y + 2, boxWidth, boxHeight);

    y += boxHeight + 8;

    // ── Footer ────────────────────────────────────────────────
    pdf.setDrawColor(200, 210, 220);
    pdf.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    const footerText = `Document généré par OsteoSoft — ${officeHeading}`;
    pdf.text(footerText, pageWidth / 2, pageHeight - 5, { align: 'center' });

    return pdf.output('blob');
  }
}
