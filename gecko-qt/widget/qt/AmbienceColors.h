/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_widget_AmbienceColors_h
#define mozilla_widget_AmbienceColors_h

#include <QColor>
#include <QJsonDocument>
#include <QJsonObject>

class AmbienceColors
{
public:
    bool Update(const QString &aData)
    {
        const QJsonObject colors = QJsonDocument::fromJson(aData.toUtf8()).object();
        for (const char *scheme : {"light", "dark"}) {
            const QJsonObject palette = colors.value(QLatin1String(scheme)).toObject();
            for (const char *role : {"canvas", "text", "disabled", "surface", "border",
                                    "accent", "accentText", "link", "visited", "active",
                                    "mark", "markText"}) {
                const QString value = palette.value(QLatin1String(role)).toString();
                if (value.size() != 7 || !value.startsWith(QLatin1Char('#'))
                        || !QColor(value).isValid()) {
                    return false;
                }
            }
        }
        if (colors == mColors) {
            return false;
        }
        mColors = colors;
        return true;
    }

    QColor Color(bool aDark, const char *aRole) const
    {
        return QColor(mColors.value(aDark ? QStringLiteral("dark") : QStringLiteral("light"))
                      .toObject().value(QLatin1String(aRole)).toString());
    }

private:
    QJsonObject mColors;
};

#endif
